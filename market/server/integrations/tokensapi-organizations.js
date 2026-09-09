// Credentials are sent only to explicitly configured TokensAPI origins.
const ORIGINS=new Set(['https://tokensapi.ai','https://dev.tokensapi.ai'])
class ProviderError extends Error{
  constructor(code){super('TokensAPI organization service unavailable');this.providerCode=code}
}
function organization(value){
  if(!value||!Number.isSafeInteger(value.id)||value.id<=0||typeof value.name!=='string'||!value.name.trim()||value.name.length>200)throw new Error('Invalid organization response')
  return {id:value.id,name:value.name.trim()}
}
export function createTokensApiOrganizations(env,fetchImpl=globalThis.fetch.bind(globalThis)){
  const base=env.MARKET_ORGANIZATIONS_BASE_URL
  if(!ORIGINS.has(base))return null
  async function request(path,token,identity=false){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000)
    try{
      // Pages may run an older compatibility date that rejects Request.cache.
      // Authorization + explicit cache headers avoid identity caching without that option.
      // Workers supports manual/follow, but may reject the browser's "error" mode.
      // Manual keeps all redirects unfollowed; the non-2xx guard rejects them.
      const response=await fetchImpl(base+path,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json','Cache-Control':'no-store',Pragma:'no-cache'},redirect:'manual',signal:controller.signal})
      if(identity && [401,403].includes(response.status)){await response.body?.cancel();return null}
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
      if(result.success!==true||!Object.hasOwn(result,'data'))throw new Error('Invalid organization envelope')
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
    async resolveOrganization(apiKey){
      const data=await request('/api/current/organization',apiKey,true)
      if(data===null)return null
      if(!data||!Object.hasOwn(data,'organization'))throw new Error('Missing organization')
      if(data.organization===null)return null
      const value=organization(data.organization)
      if(!Number.isInteger(data.organization.status))throw new Error('Invalid organization status')
      return data.organization.status===1?value:null
    }
  }
  if(typeof env.MARKET_ORGANIZATIONS_TOKEN==='string'&&env.MARKET_ORGANIZATIONS_TOKEN.trim()){
    provider.listOrganizations=async()=>{
      const data=await request('/api/organizations/all',env.MARKET_ORGANIZATIONS_TOKEN)
      if(!Array.isArray(data)||data.length>10000)throw new Error('Invalid organization list')
      const items=data.map(organization)
      if(new Set(items.map(o=>o.id)).size!==items.length)throw new Error('Duplicate organization IDs')
      return items
    }
  }
  return provider
}
