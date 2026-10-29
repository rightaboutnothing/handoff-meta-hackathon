/** Only the task is needed for abstraction. Evidence and records remain local. */
export function extractPrivateTask(source){
  const text=String(source??'');
  try{const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of ['question','task','prompt','request'])if(typeof value[key]==='string'&&value[key].trim())return value[key].trim();}catch{}
  const markers=[...text.matchAll(/\b(?:general task|task|question|request)\s*:\s*/gi)];
  if(markers.length)return text.slice(markers.at(-1).index+markers.at(-1)[0].length).trim();
  // Natural-language exports often put the request before a separate JSON data
  // block. Records are not instructions, even when their field text has verbs.
  const prose=text.split(/\r?\n\s*(?=[{\[])/,1)[0],clauses=prose.split(/(?<=[.!?])\s+(?=[A-Z])|\r?\n+/).map(part=>part.trim()).filter(Boolean);
  const operation=/^(?:please\s+)?(?:calculat\w*|comput\w*|compar\w*|summari[sz]\w*|writ\w*|draft\w*|explain\w*|find|identify|list|extract|analy[sz]\w*|provide|select|describe|recommend|create|generate|outline|derive|determine|rank|return|format|answer|respond|use|round)\b/i;
  const question=/^(?:what|which|when|where|why|how|who|whose|can|could|should|would|will|is|are|does|do|may|might|must)\b/i;
  const conditional=/^(?:given|assuming|considering|based on|using|if)\b[^?]{1,180},\s*(?:how|why|what|which|when|where|who|can|could|should|would|is|are|does|do)\b/i;
  const selected=clauses.filter(clause=>operation.test(clause)||clause.endsWith('?')&&(question.test(clause)||conditional.test(clause)));
  return selected.length?selected.join(' '):prose.trim()||text.trim();
}

/** Compile only actual imperative request clauses. The caller must supply
 * locally neutralized text and independently validate every boundary layer. */
export function compileNeutralRequest(source,{maxCharacters=320}={}){
  const task=extractPrivateTask(source),clauses=task.split(/(?<=[.!?])\s+(?=[A-Z])|\r?\n+|;/).map(value=>value.trim()).filter(Boolean);
  const imperative=/^(?:please\s+)?(calculate|compute|compare|summarize|summarise|write|draft|explain|find|identify|list|extract|analyze|analyse|provide|select|describe|recommend|create|generate|outline|derive|determine|rank|return|format|answer|respond|use|round)\b/i;
  const wh=/^(?:what|which|when|where|why|how|who|whose)\b/i,tieBreak=/^(?:please\s+)?break\s+ties\b/i;
  if(!clauses.length||!clauses.some(value=>imperative.test(value)||tieBreak.test(value))||clauses.some(value=>!imperative.test(value)&&!tieBreak.test(value)&&!wh.test(value)||/[:{}\r\n]/.test(value)))return{eligible:false,code:'COMPILER_REQUIRES_IMPERATIVE_REQUEST'};
  const body=clauses.map(value=>{const plain=value.replace(/[.!?]+$/,'').replace(/^please\s+/i,'').replace(/"/g,'').replace(/^[A-Za-z]+/,word=>word.toLowerCase());return wh.test(plain)?'determine '+plain:plain;}).join(' and '),question='How can someone '+body+'?';
  if(question.length>maxCharacters)return{eligible:false,code:'COMPILER_OVER_CHARACTER_LIMIT'};
  return{eligible:true,code:'COMPILED_IMPERATIVE_REQUEST',question};
}
