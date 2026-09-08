export async function marketRequest(path,data) {
  const response=await fetch(path,{method:data?'PUT':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:data?{'content-type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{})})
  const value=await response.json()
  if(response.status===401){const error=new Error('请登录管理后台。');error.status=401;throw error}
  if(!response.ok) throw new Error(value.error||'请求失败')
  return value
}
