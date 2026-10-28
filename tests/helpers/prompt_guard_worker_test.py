"""Pure worker protocol regression: no torch import or model inference."""
import contextlib,importlib.util,json
spec=importlib.util.spec_from_file_location('pg','src/privacy/prompt_guard_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class Tensor:
    shape=(2,512)
    def __getitem__(self,key): return self
class Tokenizer:
    model_input_names=['input_ids','attention_mask']
    def encode(self,*args,**kwargs): return [7]*600
    def num_special_tokens_to_add(self,**kwargs): return 2
    def __call__(self,text,**kwargs):
        assert kwargs['max_length']==512 and kwargs['stride']==64 and kwargs['return_overflowing_tokens']
        return {'input_ids':Tensor(),'attention_mask':Tensor(),'overflow_to_sample_mapping':Tensor()}
class Probability:
    def __init__(self,score):self.score=score
    def __getitem__(self,index): assert index==(0,1);return self.score
class Torch:
    def inference_mode(self):return contextlib.nullcontext()
    def softmax(self,logits,**kwargs):return Probability(logits)
class Model:
    calls=0
    def __call__(self,**kwargs):
        assert set(kwargs)=={'input_ids','attention_mask'}
        score=[.1,.8,.4,.2][self.calls];self.calls+=1
        return type('Reply',(),{'logits':score})()
model=Model()
worker.load=lambda request:({'tokenizer':Tokenizer(),'model':model,'torch':Torch(),'positive':1},0)
result=worker.predict({'texts':['Public first document.','Public second document.'],'maxWindowTokens':512,'overlapTokens':64})
print(json.dumps({'status':result['status'],'windows':result.get('windows'),'maxScore':result.get('maxScore'),'calls':model.calls,'networkDisabled':result.get('networkDisabled')}))
