import {TextDecoder} from 'node:util';

const utf8=new TextDecoder('utf-8',{fatal:true});
const printable=text=>text.length>0&&[...text].filter(char=>/[^\p{C}]/u.test(char)||/\s/.test(char)).length/[...text].length>.9;
/** Bounded local decoding. The returned text and spans are private IPC data. */
export function decodeVariants(input,{maxDepth=3,maxVariants=16,maxBytes=65536,maxInputBytes=16384}={}){
  const text=String(input??''),variants=[],issues=[];
  if(Buffer.byteLength(text)>maxInputBytes)return{variants,issues:['INPUT_LIMIT'],limitsExceeded:true,failClosed:true};
  const seen=new Set([text]);let bytes=0;
  const add=(parent,start,end,replacement,encoding)=>{
    if(!printable(replacement))return;
    const value=parent.text.slice(0,start)+replacement+parent.text.slice(end);
    if(seen.has(value))return;
    const size=Buffer.byteLength(value);bytes+=size;
    if(variants.length>=maxVariants||bytes>maxBytes){issues.push('DECODE_LIMIT');return;}
    seen.add(value);variants.push({text:value,encoding,depth:parent.depth+1,originSpan:parent.originSpan??{start,end}});
  };
  const queue=[{text,depth:0,originSpan:null}];
  for(let index=0;index<queue.length;index++){
    const parent=queue[index];if(parent.depth>=maxDepth){if(/(?:base64|hex|%[0-9a-f]{2}|\\u[0-9a-f]{4})/i.test(parent.text))issues.push('DECODE_DEPTH_LIMIT');continue;}
    let before=variants.length;
    for(const match of parent.text.matchAll(/(?:[A-Za-z0-9+/_-]{12,}={0,2})/g)){
      const value=match[0],explicit=/base64\s*[:=]\s*$/i.test(parent.text.slice(Math.max(0,match.index-15),match.index));
      if(!explicit&&!/[0-9+/_=-]/.test(value)&&value.length<24)continue;
      try{const canonical=value.replaceAll('-','+').replaceAll('_','/'),buffer=Buffer.from(canonical,'base64');if(buffer.toString('base64').replace(/=+$/,'')!==canonical.replace(/=+$/,''))throw Error();const decoded=utf8.decode(buffer);if(!printable(decoded)){if(explicit)issues.push('UNRESOLVED_BASE64');continue;}add(parent,match.index,match.index+value.length,decoded,'base64');}catch{if(explicit)issues.push('UNRESOLVED_BASE64');}
    }
    for(const match of parent.text.matchAll(/(?:0x)?[0-9a-fA-F]{16,}/g)){
      const value=match[0].replace(/^0x/i,''),explicit=match[0].startsWith('0x')||/hex\s*[:=]\s*$/i.test(parent.text.slice(Math.max(0,match.index-12),match.index));
      try{if(value.length%2)throw Error();const decoded=utf8.decode(Buffer.from(value,'hex'));if(!printable(decoded)){if(explicit)issues.push('UNRESOLVED_HEX');continue;}add(parent,match.index,match.index+match[0].length,decoded,'hex');}catch{if(explicit)issues.push('UNRESOLVED_HEX');}
    }
    if(/%[0-9a-f]{2}/i.test(parent.text))try{add(parent,0,parent.text.length,decodeURIComponent(parent.text),'url');}catch{issues.push('INVALID_URL_ENCODING');}
    const entity=parent.text.replace(/&#(x[0-9a-f]+|\d+);|&(commat|period|colon|sol|amp|lt|gt|quot|apos);/gi,(all,number,named)=>{try{return number?String.fromCodePoint(parseInt(number.replace(/^x/i,''),/^x/i.test(number)?16:10)):({commat:'@',period:'.',colon:':',sol:'/',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[named.toLowerCase()];}catch{issues.push('INVALID_HTML_ENTITY');return all;}});
    if(entity!==parent.text)add(parent,0,parent.text.length,entity,'html-entity');
    const unicode=parent.text.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,(all,a,b,c)=>{try{return String.fromCodePoint(parseInt(a??b??c,16));}catch{issues.push('INVALID_UNICODE_ESCAPE');return all;}});
    if(unicode!==parent.text)add(parent,0,parent.text.length,unicode,'unicode-escape');
    const normalized=parent.text.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g,'');if(normalized!==parent.text)add(parent,0,parent.text.length,normalized,'unicode-normalization');
    const rot=/\brot13\s*:\s*([^\r\n]+)/i.exec(parent.text);if(rot)add(parent,rot.index,rot.index+rot[0].length,rot[1].replace(/[A-Za-z]/g,char=>String.fromCharCode(char.charCodeAt(0)+(char.toLowerCase()<='m'?13:-13))),'rot13');
    queue.push(...variants.slice(before));
    if(issues.includes('DECODE_LIMIT'))break;
  }
  const uniqueIssues=[...new Set(issues)];
  return{variants,issues:uniqueIssues,limitsExceeded:uniqueIssues.some(issue=>/LIMIT/.test(issue)),failClosed:uniqueIssues.length>0};
}
