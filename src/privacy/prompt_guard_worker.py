"""Hash-pinned, CPU-only Prompt Guard 2. No hub lookup or credentials."""
import hashlib,json,os,socket,sys,time
from pathlib import Path
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',HF_HUB_DISABLE_PROGRESS_BARS='1',TOKENIZERS_PARALLELISM='false',DO_NOT_TRACK='1')
def denied(*args,**kwargs): raise RuntimeError('NETWORK_DISABLED')
socket.create_connection=denied
socket.getaddrinfo=denied
socket.socket.connect=denied
socket.socket.connect_ex=denied
models={}
manifest=json.loads((Path(__file__).resolve().parents[2]/'config/prompt-guard-artifacts.json').read_text('utf8'))

def window_offsets(length,max_tokens=512,special_tokens=2,overlap=64):
    window=int(max_tokens)-int(special_tokens)
    if window<=overlap or window>512 or window<1 or length<0: raise ValueError('WINDOW_INVALID')
    offsets=[]
    for offset in range(0,max(1,length),window-overlap):
        offsets.append((offset,min(length,offset+window)))
        if offset+window>=length: break
    return offsets

def file_hash(file):
    value=hashlib.sha256()
    with file.open('rb') as handle:
        for chunk in iter(lambda:handle.read(4*1024*1024),b''): value.update(chunk)
    return value.hexdigest()

def load(request):
    started=time.perf_counter()
    directory=Path(request['directory']).resolve();variant=request.get('variant');expected=manifest['variants'].get(variant)
    if not expected: raise ValueError('UNAPPROVED_VARIANT')
    key=(str(directory),variant,int(request.get('torchThreads',4)))
    if key in models: return models[key],0.0
    for name,sha in expected['files'].items():
        if not (directory/name).is_file() or file_hash(directory/name)!=sha: raise ValueError('ASSET_HASH_MISMATCH')
    import torch,transformers,safetensors
    from transformers import AutoTokenizer,AutoModelForSequenceClassification
    torch.set_num_threads(key[2])
    try: torch.set_num_interop_threads(1)
    except RuntimeError: pass
    torch.use_deterministic_algorithms(True)
    tokenizer=AutoTokenizer.from_pretrained(str(directory),local_files_only=True,trust_remote_code=False)
    model=AutoModelForSequenceClassification.from_pretrained(str(directory),local_files_only=True,trust_remote_code=False,use_safetensors=True,dtype=torch.float32).to('cpu').eval()
    if model.config.num_labels!=2 or model.config.max_position_embeddings!=512: raise ValueError('UNAPPROVED_ARCHITECTURE')
    labels={int(index):str(label).strip().lower() for index,label in model.config.id2label.items()}
    if set(labels.values())=={'benign','malicious'}: positive=next(index for index,label in labels.items() if label=='malicious');mapping={str(index):label.upper() for index,label in labels.items()}
    elif labels=={0:'label_0',1:'label_1'}:
        # Authorized only after exact official asset hashes above.
        mapping=manifest['labelMapping'];positive=next(int(index) for index,label in mapping.items() if label=='MALICIOUS')
    else: raise ValueError('PENDING_MAPPING')
    info={'tokenizer':tokenizer,'model':model,'torch':torch,'positive':positive,'mapping':mapping,'versions':{'python':sys.version.split()[0],'torch':torch.__version__,'transformers':transformers.__version__,'safetensors':safetensors.__version__}}
    models[key]=info
    return info,(time.perf_counter()-started)*1000

def predict(request):
    try:
        loaded,load_ms=load(request)
        if request.get('action')=='health': return {'status':'READY','localOnly':True,'networkDisabled':True,'labelMapping':loaded['mapping'],'versions':loaded['versions'],'loadMs':load_ms}
        tokenizer,model,torch=loaded['tokenizer'],loaded['model'],loaded['torch']
        windows=0;maximum=0.0;tokenize_ms=0.0;inference_ms=0.0
        for text in request['texts']:
            start=time.perf_counter();ids=tokenizer.encode(text,add_special_tokens=False);tokenize_ms+=(time.perf_counter()-start)*1000
            if len(ids)>131072: raise ValueError('INPUT_LIMIT')
            expected=window_offsets(len(ids),int(request['maxWindowTokens']),tokenizer.num_special_tokens_to_add(pair=False),int(request['overlapTokens']))
            start=time.perf_counter()
            # Native overflow handles model-specific special tokens on both
            # Transformers 4 and 5; the removed prepare_for_model API is avoided.
            encoded=tokenizer(text,add_special_tokens=True,truncation=True,max_length=int(request['maxWindowTokens']),stride=int(request['overlapTokens']),return_overflowing_tokens=True,padding=True,return_tensors='pt')
            tokenize_ms+=(time.perf_counter()-start)*1000
            if encoded['input_ids'].shape[0]!=len(expected) or encoded['input_ids'].shape[1]>512: raise ValueError('WINDOW_INVALID')
            for index in range(len(expected)):
                inputs={name:value[index:index+1] for name,value in encoded.items() if name in tokenizer.model_input_names and name in {'input_ids','attention_mask','token_type_ids'}}
                start=time.perf_counter()
                with torch.inference_mode(): score=float(torch.softmax(model(**inputs).logits,dim=-1)[0,loaded['positive']])
                inference_ms+=(time.perf_counter()-start)*1000;maximum=max(maximum,score);windows+=1
        return {'status':'READY','localOnly':True,'networkDisabled':True,'windows':windows,'maxScore':maximum,'loadMs':load_ms,'tokenizeMs':tokenize_ms,'inferenceMs':inference_ms}
    except Exception as error:
        code=str(error)
        return {'status':'PENDING','localOnly':True,'networkDisabled':True,'reason':code if code in {'PENDING_MAPPING','UNAPPROVED_VARIANT','ASSET_HASH_MISMATCH','UNAPPROVED_ARCHITECTURE','WINDOW_INVALID','INPUT_LIMIT'} else 'LOCAL_MODEL_UNAVAILABLE'}

if __name__=='__main__':
    for line in sys.stdin:
        request_id=None
        try: request=json.loads(line);request_id=request.get('id');result=predict(request)
        except Exception: result={'status':'PENDING','localOnly':True,'networkDisabled':True,'reason':'LOCAL_PROTOCOL_ERROR'}
        result['id']=request_id;sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n');sys.stdout.flush()
