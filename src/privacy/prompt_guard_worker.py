"""Offline-only Prompt Guard 2. No hub lookup or credential use, ever."""
import json, os, sys
from pathlib import Path
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
models={}
def predict(request):
    directory=Path(request['directory']).resolve()
    if not (directory/'config.json').is_file() or not list(directory.glob('*.safetensors')):
        return {'status':'PENDING','localOnly':True}
    try:
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        key=str(directory)
        if key not in models:
            tokenizer=AutoTokenizer.from_pretrained(key,local_files_only=True,trust_remote_code=False)
            model=AutoModelForSequenceClassification.from_pretrained(key,local_files_only=True,trust_remote_code=False,use_safetensors=True).eval()
            if model.config.num_labels!=2: return {'status':'PENDING','localOnly':True}
            models[key]=(tokenizer,model)
        tokenizer,model=models[key]
        labels={int(index):str(label).strip().lower() for index,label in model.config.id2label.items()}
        if set(labels.values())!={'benign','malicious'}:
            return {'status':'PENDING','localOnly':True,'reason':'PENDING_MAPPING'}
        positive=next(index for index,label in labels.items() if label=='malicious')
        window=int(request['maxWindowTokens'])-tokenizer.num_special_tokens_to_add(pair=False)
        overlap=int(request['overlapTokens'])
        if window<=overlap or window>512: raise ValueError()
        windows=0; maximum=0.0
        for text in request['texts']:
            ids=tokenizer.encode(text,add_special_tokens=False)
            if len(ids)>131072: raise ValueError()
            for start in range(0,max(1,len(ids)),window-overlap):
                chunk=ids[start:start+window]
                encoded=tokenizer.prepare_for_model(chunk,add_special_tokens=True,return_tensors='pt',return_attention_mask=True)
                with torch.no_grad(): score=float(torch.softmax(model(**encoded).logits,dim=-1)[0,positive])
                maximum=max(maximum,score);windows+=1
                if start+window>=len(ids): break
        return {'status':'READY','localOnly':True,'windows':windows,'maxScore':maximum}
    except Exception:
        return {'status':'PENDING','localOnly':True}
for line in sys.stdin:
    request_id=None
    try:
        request=json.loads(line);request_id=request.get('id');result=predict(request)
    except Exception: result={'status':'PENDING','localOnly':True}
    result['id']=request_id
    sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n');sys.stdout.flush()
