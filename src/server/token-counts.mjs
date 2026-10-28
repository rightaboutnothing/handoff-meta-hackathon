import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import { serializeLeanUserPayload } from '../comparison/handoff-payload.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const defaultDirectory=path.join(root,'.cache/tokenizers');
const sha=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const TOKENIZER_SOURCES=Object.freeze({
  gemini:{cloudModelId:'gemini-3.1-flash-lite',repository:'google/gemma-4-E4B-it',revision:'ee0ef6023621cff504d758262d4e04895a5af4a2',
    files:{'tokenizer.json':'cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f','tokenizer_config.json':'9f4fec4b1dc6ecddf8f4a92e9caea5971c0e67d81309f3f9066a2bee8c362633'},
    mappingSdkRepository:'googleapis/python-genai',mappingSdkRevision:'6e80d42acf101a6b51d91021025e509170b388bf',
    mappingSource:'https://github.com/googleapis/python-genai/blob/6e80d42acf101a6b51d91021025e509170b388bf/google/genai/_local_tokenizer_loader.py',
    countSource:'https://github.com/googleapis/python-genai/blob/6e80d42acf101a6b51d91021025e509170b388bf/google/genai/local_tokenizer.py'},
  'muse-spark':{cloudModelId:'muse-spark-1.3',proxyModelId:'llama3.1:8b',
    algorithmRevision:'a0940f9cf7065d45bb6675660f80d305c041a754',
    algorithmSource:'https://github.com/meta-llama/llama3/blob/a0940f9cf7065d45bb6675660f80d305c041a754/llama/tokenizer.py',
    limitation:'Muse Spark has no public tokenizer in this project. Installed Llama 3.1 BPE counts are a documented proxy, not actual Muse Spark billed tokens.'},
});
const llamaPattern="(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+";

/** Reads only GGUF metadata already installed by the user, never model tensors. */
export function readGgufMetadata(buffer){
  let position=0;
  const take=size=>{if(position+size>buffer.length)throw new Error('GGUF metadata exceeds the bounded prefix');const start=position;position+=size;return start;};
  const u32=()=>buffer.readUInt32LE(take(4));
  const u64=()=>{const value=buffer.readBigUInt64LE(take(8));if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('GGUF metadata length is not safe');return Number(value);};
  const string=()=>{const length=u64();return buffer.toString('utf8',take(length),position);};
  const value=type=>{
    if(type===0)return buffer.readUInt8(take(1));if(type===1)return buffer.readInt8(take(1));
    if(type===2)return buffer.readUInt16LE(take(2));if(type===3)return buffer.readInt16LE(take(2));
    if(type===4)return u32();if(type===5)return buffer.readInt32LE(take(4));
    if(type===6)return buffer.readFloatLE(take(4));if(type===7)return buffer.readUInt8(take(1))!==0;
    if(type===8)return string();if(type===10)return u64();if(type===11)return Number(buffer.readBigInt64LE(take(8)));
    if(type===12)return buffer.readDoubleLE(take(8));
    if(type===9){const elementType=u32(),count=u64();if(count>2_000_000)throw new Error('GGUF array exceeds tokenizer bounds');return Array.from({length:count},()=>value(elementType));}
    throw new Error('Unsupported GGUF metadata type');
  };
  if(buffer.toString('ascii',take(4),position)!=='GGUF')throw new Error('Installed tokenizer source is not GGUF');
  const version=u32();if(![2,3].includes(version))throw new Error('Unsupported GGUF version');
  const tensorCount=u64(),count=u64();if(count>100_000)throw new Error('GGUF metadata count exceeds bounds');
  const metadata={};for(let index=0;index<count;index++){const key=string(),type=u32();metadata[key]=value(type);}
  return{version,tensorCount,metadataBytes:position,metadata};
}
export function llamaTokenizerJson(metadata){
  if(metadata['tokenizer.ggml.model']!=='gpt2'||!['llama-bpe','llama3'].includes(metadata['tokenizer.ggml.pre']))throw new Error('Installed Llama proxy does not declare the supported Llama BPE pretokenizer');
  const tokens=metadata['tokenizer.ggml.tokens'],merges=metadata['tokenizer.ggml.merges'];
  if(!Array.isArray(tokens)||!Array.isArray(merges)||tokens.length<128000||merges.length<100000)throw new Error('Installed Llama proxy tokenizer metadata is incomplete');
  const pairs=merges.map(merge=>{const pair=merge.split(' ');if(pair.length!==2)throw new Error('Invalid Llama merge pair');return pair;});
  return{version:'1.0',truncation:null,padding:null,added_tokens:[],normalizer:null,
    pre_tokenizer:{type:'Sequence',pretokenizers:[{type:'Split',pattern:{Regex:llamaPattern},behavior:'Isolated',invert:false},{type:'ByteLevel',add_prefix_space:false,trim_offsets:false,use_regex:false}]},
    post_processor:null,decoder:{type:'ByteLevel',add_prefix_space:false,trim_offsets:false,use_regex:false},
    model:{type:'BPE',dropout:null,unk_token:null,continuing_subword_prefix:'',end_of_word_suffix:'',fuse_unk:false,byte_fallback:false,ignore_merges:false,vocab:Object.fromEntries(tokens.map((token,index)=>[token,index])),merges:pairs}};
}

export async function prepareTokenizerAssets({directory=defaultDirectory,ollamaDirectory=process.env.OLLAMA_MODELS||path.join(os.homedir(),'.ollama/models'),fetchImpl=globalThis.fetch}={}){
  const googleDirectory=path.join(directory,'gemini-3.1-flash-lite');await mkdir(googleDirectory,{recursive:true});
  for(const[file,expected]of Object.entries(TOKENIZER_SOURCES.gemini.files)){
    let bytes;try{bytes=await readFile(path.join(googleDirectory,file));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!bytes){const url=`https://huggingface.co/${TOKENIZER_SOURCES.gemini.repository}/resolve/${TOKENIZER_SOURCES.gemini.revision}/${file}`;const response=await fetchImpl(url,{redirect:'follow'});if(!response.ok)throw new Error(`Public tokenizer artifact download failed HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
    if(sha(bytes)!==expected)throw new Error('Pinned Google tokenizer artifact hash mismatch');
    await writeFile(path.join(googleDirectory,file),bytes,{mode:0o600});
  }
  const manifestBytes=await readFile(path.join(ollamaDirectory,'manifests/registry.ollama.ai/library/llama3.1/8b'));
  const manifest=JSON.parse(manifestBytes),layer=manifest.layers?.find(row=>row.mediaType==='application/vnd.ollama.image.model');
  if(!/^sha256:[a-f0-9]{64}$/.test(layer?.digest??''))throw new Error('Installed Llama proxy model manifest is invalid');
  const handle=await open(path.join(ollamaDirectory,'blobs',layer.digest.replace(':','-')),'r');let parsed;
  try{const prefix=Buffer.alloc(32*1024*1024);const{bytesRead}=await handle.read(prefix,0,prefix.length,0);parsed=readGgufMetadata(prefix.subarray(0,bytesRead));}finally{await handle.close();}
  const model=llamaTokenizerJson(parsed.metadata),proxyDirectory=path.join(directory,'muse-spark-proxy');await mkdir(proxyDirectory,{recursive:true});
  const tokenizerBytes=Buffer.from(JSON.stringify(model)),configBytes=Buffer.from(JSON.stringify({model_max_length:131072,clean_up_tokenization_spaces:false}));
  await writeFile(path.join(proxyDirectory,'tokenizer.json'),tokenizerBytes,{mode:0o600});await writeFile(path.join(proxyDirectory,'tokenizer_config.json'),configBytes,{mode:0o600});
  const manifestRecord={schemaVersion:1,gemini:{...TOKENIZER_SOURCES.gemini},'muse-spark':{...TOKENIZER_SOURCES['muse-spark'],sourceManifestSha256:sha(manifestBytes),sourceModelBlobDigest:layer.digest,metadataBytes:parsed.metadataBytes,
    tokenizerMetadataSha256:sha({tokens:parsed.metadata['tokenizer.ggml.tokens'],merges:parsed.metadata['tokenizer.ggml.merges'],pre:parsed.metadata['tokenizer.ggml.pre']}),
    files:{'tokenizer.json':sha(tokenizerBytes),'tokenizer_config.json':sha(configBytes)}}};
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifestRecord,null,2)+'\n',{mode:0o600});return manifestRecord;
}

function payloadSections(payload){
  if(typeof payload.system!=='string'||typeof payload.query!=='string'||!Array.isArray(payload.context))throw new Error('A structured handoff payload is required for token counting');
  const question={...payload,context:[],draft:null},context={...payload,draft:null};
  return{system:payload.system,query:payload.query,context:payload.segments?.retrievedContext??payload.context.map(row=>`[${row.chunkId}]\n${row.text}`).join('\n\n'),draft:payload.draft??'',
    questionUser:serializeLeanUserPayload(question),contextUser:serializeLeanUserPayload(context),fullUser:serializeLeanUserPayload(payload)};
}
export function assemblePayloadCount(cloudId,payload,encode,metadata){
  if(payload.eligible===false)return{status:'ineligible_local_only',cloudId,inputTokens:0,contentTokens:0,billingInputTokens:null,serverFramingTokens:null,metadata,components:{instructions:0,query:0,retrievedChunks:0,localDraft:0,serializationLabelsAndSeparators:0,guardWrapper:0,receiptMetadata:0,piiMap:0}};
  const sections=payloadSections(payload),count=text=>encode(String(text)).length;
  const system=count(sections.system),query=count(sections.query),questionUser=count(sections.questionUser),contextUser=count(sections.contextUser),fullUser=count(sections.fullUser);
  const inputTokens=system+fullUser;
  const components={instructions:system,query,retrievedChunks:contextUser-questionUser,localDraft:fullUser-contextUser,serializationLabelsAndSeparators:questionUser-query,guardWrapper:0,receiptMetadata:0,piiMap:0};
  const standalone={instructions:system,query,retrievedChunks:count(sections.context),localDraft:count(sections.draft)};
  if(Object.values(components).reduce((a,b)=>a+b,0)!==inputTokens)throw new Error('Token source attribution did not telescope to the exact content count');
  return{status:'counted_locally',cloudId,inputTokens,contentTokens:inputTokens,billingInputTokens:null,serverFramingTokens:null,
    providerWireTextHash:sha({system:sections.system,user:sections.fullUser}),components,standalone,
    attributionMethod:'Exact telescoping marginal counts in order: system; labeled query; retrieved context; optional draft. Marginals can be negative at BPE boundaries. Guard/receipts/PII maps have no wire bytes.',
    framingNote:'Provider server-side chat/control framing is not publicly specified. It remains unknown, rather than being invented as zero. Pricing uses exact local content-token counts and is a forecast, not a billed-token measurement.',metadata};
}
export async function createLocalTokenCounters({directory=defaultDirectory}={}){
  let manifest;try{manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));}catch(error){if(error.code==='ENOENT')throw new Error('Local tokenizer assets are missing. Run node scripts/prepare-tokenizers.mjs before Tier 0.');throw error;}
  const encoders={},metadata={},textCache=new Map(),payloadCache=new Map();
  for(const[cloudId,folder]of [['gemini','gemini-3.1-flash-lite'],['muse-spark','muse-spark-proxy']]){
    const record=manifest[cloudId];if(!record?.files)throw new Error('Local tokenizer manifest is incomplete');
    if(cloudId==='gemini'&&(record.revision!==TOKENIZER_SOURCES.gemini.revision||JSON.stringify(record.files)!==JSON.stringify(TOKENIZER_SOURCES.gemini.files)))throw new Error('Google tokenizer revision differs from the pinned provider mapping');
    const content={};for(const[file,expected]of Object.entries(record.files)){const bytes=await readFile(path.join(directory,folder,file));if(sha(bytes)!==expected)throw new Error('Cached tokenizer artifact hash mismatch');content[file]=JSON.parse(bytes);}
    const tokenizer=new Tokenizer(content['tokenizer.json'],content['tokenizer_config.json']);encoders[cloudId]=text=>tokenizer.encode(text,{add_special_tokens:false}).ids;
    metadata[cloudId]={...record,method:cloudId==='gemini'?'provider_selected_local_tokenizer':'documented_local_proxy',
      tokenizerLibrary:'@huggingface/tokenizers@0.2.0',specialTokens:'No automatic BOS/EOS or undocumented server chat framing',
      exactForSelectedTokenizer:true,exactProviderBillingTokens:false,remoteCountRequests:0,cloudInferenceCalls:0,
      limitation:cloudId==='gemini'?'Google SDK selects this public tokenizer for Gemini 3.1 Flash-Lite; the local SDK is experimental/text-only. Hidden server framing and tokenizer deployment revisions are not measured by an API request.':record.limitation};
  }
  const countText=(cloudId,text)=>{if(!encoders[cloudId])throw new Error('Unknown cloud tokenizer');text=String(text);const key=`${cloudId}:${sha(text)}`;if(!textCache.has(key))textCache.set(key,encoders[cloudId](text).length);return textCache.get(key);};
  return{metadata,countText,countPayload(cloudId,payload){
    if(!encoders[cloudId])throw new Error('Unknown cloud tokenizer');
    const key=`${cloudId}:${sha(payload.eligible===false?{eligible:false}:{system:payload.system,user:serializeLeanUserPayload(payload)})}`;
    if(!payloadCache.has(key))payloadCache.set(key,assemblePayloadCount(cloudId,payload,text=>({length:countText(cloudId,text)}),metadata[cloudId]));
    return structuredClone(payloadCache.get(key));
  }};
}
