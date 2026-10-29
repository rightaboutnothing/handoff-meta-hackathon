import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,open,rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

const marker=/\[\[LOCAL_[a-f0-9]{32}\]\]/g;
export async function createQuestionTokenVault(directory,{keyDirectory}={}){
  if(!directory)throw Error('A private local vault directory is required');
  directory=path.resolve(directory);await mkdir(directory,{recursive:true,mode:0o700});
  const machineKeys=path.resolve(keyDirectory??(process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Handoff/privacy-keys'):path.join(os.homedir(),'.local/share/handoff/privacy-keys')));await mkdir(machineKeys,{recursive:true,mode:0o700});
  const identity=createHash('sha256').update(directory).digest('hex'),keyFile=path.join(machineKeys,identity+'.key'),mapFile=path.join(directory,'question-map.enc.json');
  let key;try{key=await readFile(keyFile);}catch(error){if(error.code!=='ENOENT')throw Error('Local token key unavailable');key=randomBytes(32);try{await writeFile(keyFile,key,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw Error('Local token key unavailable');key=await readFile(keyFile);}}
  if(key.length!==32)throw Error('Local token key invalid');
  let entries=[];try{const record=JSON.parse(await readFile(mapFile,'utf8'));if(record.version!==1||record.algorithm!=='aes-256-gcm')throw Error();const decrypt=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'base64'));decrypt.setAAD(Buffer.from('handoff-question-map-v1'));decrypt.setAuthTag(Buffer.from(record.tag,'base64'));entries=JSON.parse(Buffer.concat([decrypt.update(Buffer.from(record.ciphertext,'base64')),decrypt.final()]).toString('utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Local encrypted token map unavailable');}
  const byToken=new Map(entries.map(row=>[row.token,row])),byValue=new Map(entries.map(row=>[row.value,row.token]));
  function register(value,type='PRIVATE'){
    if(typeof value!=='string'||!value)return null;
    let token=byValue.get(value);if(!token){token=`[[LOCAL_${randomBytes(16).toString('hex')}]]`;byValue.set(value,token);byToken.set(token,{token,type,value});}return token;
  }
  function tokenize(text,findings=[]){
    const input=String(text),spans=findings.filter(row=>Number.isInteger(row.start)&&Number.isInteger(row.end)&&row.start>=0&&row.end>row.start&&row.end<=input.length).sort((a,b)=>a.start-b.start||b.end-a.end),chosen=[];let end=-1;
    for(const row of spans){if(row.start<end)continue;chosen.push(row);end=row.end;}
    let result='',position=0;for(const row of chosen){const value=input.slice(row.start,row.end),token=register(value,row.type);result+=input.slice(position,row.start)+token;position=row.end;}result+=input.slice(position);
    return{text:result,replacements:chosen.length,tokens:chosen.map(row=>byValue.get(input.slice(row.start,row.end)))};
  }
  function tokenizeValues(text,values=[]){let result=String(text),replacements=0;for(const row of [...values].sort((a,b)=>String(b.value).length-String(a.value).length)){if(typeof row.value!=='string'||!row.value)continue;const token=register(row.value,row.type);result=result.split(/(\[(?:PERSON|COMPANY|AMOUNT|DATE|IDENTIFIER|ADDRESS|PHONE|EMAIL|VALUE|PRODUCT|RECORD)\]|\[\[LOCAL_[a-f0-9]{32}\]\])/g).map((part,index)=>{if(index%2)return part;const pieces=part.split(row.value);replacements+=pieces.length-1;return pieces.join(token);}).join('');}return{text:result,replacements};}
  async function save(){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('handoff-question-map-v1'));
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify([...byToken.values()]),'utf8'),cipher.final()]);
    const body=JSON.stringify({version:1,algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
    const file=mapFile+'.'+randomBytes(8).toString('hex')+'.tmp',handle=await open(file,'wx',0o600);try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}await rename(file,mapFile);
  }
  return{register,tokenize,tokenizeValues,save,restore:text=>{const restored=String(text).replace(marker,token=>{if(!byToken.has(token))throw Error('Unknown local privacy token');return byToken.get(token).value;});if(restored.includes('[[LOCAL_'))throw Error('Unresolved local privacy token');return restored;},abstract:text=>String(text).replace(marker,'a private entity'),values:()=>[...byToken.values()].map(({type,value})=>({type,value})),stats:()=>({entries:byToken.size,encryptedAtRest:true,algorithm:'aes-256-gcm',machineLocalKeyStore:true})};
}
export const containsLocalToken=text=>/\[\[(?:LOCAL_|PII_)/.test(String(text));
