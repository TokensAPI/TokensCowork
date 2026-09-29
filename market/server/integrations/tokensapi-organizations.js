// Credentials are sent only to explicitly configured TokensAPI origins.
const ORIGINS=new Set(['https://tokensapi.ai','https://dev.tokensapi.ai'])
// The access token a person pastes when signing in to the console. Restricted to the printable
// characters a header value may legally carry, so a hostile value cannot smuggle a second field.
const TOKEN_VALUE=/^[\x21-\x7e]{1,4096}$/u
// TokensAPI rejects an access token unless the numeric account id travels beside it, so the
// console credential is always the pair. Anything else is not a credential at all.
function consoleCredential(value){
  if(!value||typeof value.accessToken!=='string'||!TOKEN_VALUE.test(value.accessToken))return null
  if(!Number.isSafeInteger(value.userId)||value.userId<=0)return null
  return {accessToken:value.accessToken,userId:value.userId}
}
class ProviderError extends Error{
  constructor(code){super('TokensAPI organization service unavailable');this.providerCode=code}
}
function organization(value){
  if(!value||!Number.isSafeInteger(value.id)||value.id<=0||typeof value.name!=='string'||!value.name.trim()||value.name.length>200)throw new Error('Invalid organization response')
  return {id:value.id,name:value.name.trim()}
}
// A TokensAPI account as the market shows it: the id grants are keyed on, and a display name.
function account(value){
  if(!value||!Number.isSafeInteger(value.id)||value.id<=0||typeof value.username!=='string'||!value.username.trim())throw new Error('Invalid user response')
  const display=typeof value.display_name==='string'&&value.display_name.trim()?value.display_name:value.username
  return {id:value.id,name:display.trim().slice(0,200),username:value.username.trim().slice(0,200)}
}
export function createTokensApiOrganizations(env,fetchImpl=globalThis.fetch.bind(globalThis)){
  const base=env.MARKET_ORGANIZATIONS_BASE_URL
  if(!ORIGINS.has(base))return null
  // `credential` is either an API key (sent as a bearer token) or a console credential —
  // {accessToken,userId}, pasted by the person signing in, forwarded for one call and never
  // retained here. TokensAPI reads the token from Authorization and the id from New-Api-User.
  async function request(path,credential,mode=''){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000)
    try{
      // Pages may run an older compatibility date that rejects Request.cache.
      // Authorization + explicit cache headers avoid identity caching without that option.
      // Workers supports manual/follow, but may reject the browser's "error" mode.
      // Manual keeps all redirects unfollowed; the non-2xx guard rejects them.
      const auth=typeof credential==='string'
        ?{Authorization:'Bearer '+credential}
        :{Authorization:credential.accessToken,'New-Api-User':String(credential.userId)}
      const response=await fetchImpl(base+path,{method:'GET',headers:{...auth,Accept:'application/json','Cache-Control':'no-store',Pragma:'no-cache'},redirect:'manual',signal:controller.signal})
      // 401 is "this credential is not signed in", 403 is "signed in but not entitled". Both are
      // answers rather than outages, so they are named; everything else stays a provider failure.
      if(mode && [401,403].includes(response.status)){
        await response.body?.cancel()
        throw new ProviderError(mode==='account'
          ?(response.status===401?'CREDENTIAL_INVALID':'NOT_A_MEMBER')
          :(response.status===401?'KEY_INVALID':'KEY_DISABLED'))
      }
      if(!response.ok)throw new ProviderError('HTTP_'+response.status)
      const reader=response.body?.getReader()
      if(!reader)throw new Error('Empty organization response')
      const chunks=[];let size=0
      while(true){
        const {done,value}=await reader.read();if(done)break
        size+=value.length
        if(size>2*1024*1024){await reader.cancel();throw new Error('Organization response too large')}
        chunks.push(value)
      }
      const bytes=new Uint8Array(size);let offset=0
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
      const result=JSON.parse(new TextDecoder().decode(bytes))
      // A console credential TokensAPI refuses comes back as 200 with success:false, so the
      // refusal has to be read from the envelope rather than the status line. Reading it any
      // other way would turn "wrong token" into "upstream down" and hide the real answer.
      if(result.success!==true||!Object.hasOwn(result,'data')){
        if(mode==='account'&&result&&result.success===false)throw new ProviderError('CREDENTIAL_INVALID')
        throw new Error('Invalid organization envelope')
      }
      return result.data
    }catch(error){
      if(error instanceof ProviderError)throw error
      const reason=String(error?.message??'')
      const transport=reason.includes('Illegal invocation')?'FETCH_BINDING':reason.toLowerCase().includes('cache')?'CACHE_OPTION':reason.toLowerCase().includes('redirect')?'REDIRECT':reason.toLowerCase().includes('header')?'HEADER':'TRANSPORT_TYPE_ERROR'
      throw new ProviderError(controller.signal.aborted?'TIMEOUT':error instanceof SyntaxError?'INVALID_JSON':error instanceof TypeError?transport:'INVALID_RESPONSE')
    }
    finally{clearTimeout(timer)}
  }
  const provider={
    async validateApiKey(apiKey){
      let data
      try { data=await request('/api/current/organization',apiKey,'identity') }
      catch(error) {
        if(error.providerCode==='KEY_INVALID')return {status:'invalid',organization:null,user:null}
        if(error.providerCode==='KEY_DISABLED')return {status:'disabled',organization:null,user:null}
        throw error
      }
      if(!data||!Object.hasOwn(data,'organization'))throw new Error('Missing organization')
      // The Key's owner. A TokensAPI that does not report it yet leaves user grants unmatched
      // instead of failing the whole answer.
      const user=data.user==null?null:account(data.user)
      if(data.organization===null)return {status:'valid',organization:null,user}
      const value=organization(data.organization)
      if(!Number.isInteger(data.organization.status))throw new Error('Invalid organization status')
      return data.organization.status===1?{status:'valid',organization:value,user}:{status:'disabled',organization:null,user:null}
    },
    async resolveOrganization(apiKey){
      return (await provider.validateApiKey(apiKey)).organization
    },
    async resolveIdentity(apiKey){
      const {organization,user}=await provider.validateApiKey(apiKey)
      return {organization,user:user?{id:user.id,name:user.name}:null}
    },
    // The console login path. The market never sees a password: the person pastes the access
    // token from their TokensAPI settings, and these two calls ask TokensAPI who it belongs to
    // and what they may do. Null means "this credential is nobody" — an answer, not a failure.
    async resolveAccount(credential){
      const value=consoleCredential(credential)
      if(!value)return null
      let data
      try { data=await request('/api/user/self',value,'account') }
      catch(error){ if(error.providerCode==='CREDENTIAL_INVALID')return null; throw error }
      if(!data||!Number.isSafeInteger(data.id)||data.id<=0||typeof data.username!=='string'||!data.username.trim())throw new Error('Invalid account response')
      const display=typeof data.display_name==='string'&&data.display_name.trim()?data.display_name:data.username
      return {id:data.id,username:data.username.trim().slice(0,200),displayName:display.trim().slice(0,200)}
    },
    // The organization that account belongs to, with the role TokensAPI assigns them. Null
    // covers "credential is nobody", "belongs to none" and "membership disabled": no seat.
    async resolveMyOrg(credential){
      const pair=consoleCredential(credential)
      if(!pair)return null
      let data
      try { data=await request('/api/org/',pair,'account') }
      catch(error){ if(['CREDENTIAL_INVALID','NOT_A_MEMBER'].includes(error.providerCode))return null; throw error }
      const value=organization(data)
      if(!Number.isInteger(data.status)||!Number.isInteger(data.my_role))throw new Error('Invalid organization membership')
      return data.status===1?{...value,role:data.my_role}:null
    },
  }
  if(typeof env.MARKET_ORGANIZATIONS_TOKEN==='string'&&env.MARKET_ORGANIZATIONS_TOKEN.trim()){
    provider.listOrganizations=async()=>{
      const data=await request('/api/organizations/all',env.MARKET_ORGANIZATIONS_TOKEN)
      if(!Array.isArray(data)||data.length>10000)throw new Error('Invalid organization list')
      const items=data.map(organization)
      if(new Set(items.map(o=>o.id)).size!==items.length)throw new Error('Duplicate organization IDs')
      return items
    }
    // The console's user picker. TokensAPI answers one page of matches; the market keeps only
    // the users an administrator actually grants something to. Each match names its organization
    // (org_id, 0 for none), which is how an organization's own members are told apart.
    provider.searchUsers=async(keyword,page,size=20)=>{
      const data=await request(`/api/manage/users/search?keyword=${encodeURIComponent(keyword)}&p=${page}&page_size=${size}`,env.MARKET_ORGANIZATIONS_TOKEN)
      if(!data||!Array.isArray(data.items)||data.items.length>100||!Number.isSafeInteger(data.total)||data.total<0)throw new Error('Invalid user list')
      return {items:data.items.map(value=>({...account(value),organizationId:Number.isSafeInteger(value.org_id)&&value.org_id>0?value.org_id:null})),total:data.total}
    }
  }
  return provider
}
