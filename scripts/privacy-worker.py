"""Local JSONL IPC worker. Never writes input, findings or tracebacks to logs."""
import sys, json, re, os, time, ipaddress, datetime, importlib, pathlib, logging, hashlib
import socket
logging.disable(logging.CRITICAL)
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
def no_network(*args,**kwargs): raise OSError('LOCAL_PRIVACY_NETWORK_DISABLED')
socket.create_connection=no_network
socket.socket.connect=no_network
socket.socket.connect_ex=no_network
ROOT=pathlib.Path(__file__).resolve().parent.parent
RULES=ROOT/'config'/'privacy-rules'
MODULES={}
ANALYZER=None

def load_rules():
    found=[]
    for file in sorted(RULES.glob('*.json')):
        document=json.loads(file.read_text('utf8'))
        if document.get('schemaVersion')!=1 or not isinstance(document.get('rules'),list):
            raise ValueError('RULE_CONFIGURATION')
        for rule in document['rules']:
            found.append(dict(rule,country=document['country'],compiled=re.compile(rule['pattern'],re.I)))
    if not found: raise ValueError('RULE_CONFIGURATION')
    return found

def digits(value): return re.sub(r'\D','',value)

def luhn(value):
    number=digits(value)
    if not number or len(set(number))<2: return False
    total=0
    for index,char in enumerate(reversed(number)):
        n=int(char)
        if index%2: n=n*2; n=n-9 if n>9 else n
        total+=n
    return total%10==0

def validate(value,rule):
    kind=rule['validator']; compact=re.sub(r'[ -]','',value).upper()
    if kind.startswith('stdnum.'):
        module=MODULES.setdefault(kind,importlib.import_module(kind))
        return bool(module.is_valid(value))
    if kind=='format': return True
    if kind=='keyword_identifier': return bool(re.search(r'\d',compact)) and 6<=len(compact)<=24
    if kind=='email':
        import idna
        try:
            local,domain=value.rsplit('@',1)
            return bool(local) and not re.search(r'[\s\x00-\x1f]',local) and bool(idna.encode(domain,uts46=True))
        except (ValueError,idna.IDNAError): return False
    if kind=='ip':
        try: ipaddress.ip_address(value); return True
        except ValueError: return False
    if kind=='luhn': return rule.get('minDigits',0)<=len(digits(value))<=rule.get('maxDigits',99) and luhn(value)
    if kind=='date':
        normalized=re.sub(r'\bSept\b','Sep',re.sub(r'\b([A-Za-z]{3,4})\.',r'\1',value),flags=re.I)
        for format in ('%Y-%m-%d','%Y/%m/%d','%Y.%m.%d','%d-%m-%Y','%d/%m/%Y','%m/%d/%Y','%d.%m.%Y','%d-%m-%y','%d/%m/%y','%m/%d/%y','%d %b %Y','%d %B %Y','%d-%b-%Y','%d-%B-%Y','%b %d, %Y','%B %d, %Y','%b %d %Y','%B %d %Y'):
            try:
                date=datetime.datetime.strptime(normalized,format).date()
                if 1850<=date.year<=datetime.date.today().year: return True
            except ValueError: pass
        return False
    if kind=='au_medicare':
        number=digits(value)
        return len(number) in (10,11) and number[0] in '23456' and number[9] in '123456789' and (len(number)==10 or number[10] in '123456789') and sum(int(n)*w for n,w in zip(number[:8],[1,3,7,9,1,3,7,9]))%10==int(number[8])
    if kind=='us_ssn':
        number=digits(value)
        return len(number)==9 and number[:3] not in ('000','666') and int(number[:3])<900 and number[3:5]!='00' and number[5:]!='0000'
    if kind=='us_itin':
        number=digits(value)
        return len(number)==9 and number.startswith('9') and int(number[3:5]) in list(range(50,66))+list(range(70,89))+[90,91,92]+list(range(94,100)) and number[-4:]!='0000'
    if kind=='gb_nino':
        return bool(re.fullmatch(r'[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]',compact)) and compact[:2] not in ('BG','GB','KN','NK','NT','TN','ZZ')
    raise ValueError('UNKNOWN_VALIDATOR')

def kw_near(text,start,end,keywords,window=40):
    before=text[max(0,start-window):start].casefold(); after=text[end:end+window].casefold()
    return any(keyword.casefold() in before or keyword.casefold() in after for keyword in keywords)

def scan(text,countries=None):
    import phonenumbers
    rules=load_rules(); findings=[]; country_set=set(countries) if countries else None
    for rule in rules:
        if country_set and rule['country']!='UNIVERSAL' and rule['country'] not in country_set: continue
        for match in rule['compiled'].finditer(text):
            group=rule.get('group',0); start,end=match.span(group); value=match.group(group)
            if rule.get('keywords') and not kw_near(text,start,end,rule['keywords'],rule.get('keywordWindow',40)): continue
            if rule.get('validatedPrefix'):
                # A permissive spaced identifier candidate may include following
                # prose. Only accept a checksum-valid prefix at a real boundary;
                # never carve a valid prefix from one unbroken invalid value.
                original=value
                for cut in range(len(original),0,-1):
                    if original[cut-1].isspace() or (cut<len(original) and not original[cut].isspace()): continue
                    prefix=original[:cut]
                    if len(re.sub(r'[ -]','',prefix))<15: break
                    if validate(prefix,rule): value=prefix;end=start+cut;break
            is_valid=validate(value,rule)
            if is_valid:
                validity=rule.get('validationKind') or ('format' if rule['validator'] in ('format','keyword_identifier','email','ip','date','us_ssn','us_itin','gb_nino') else 'checksum_valid')
                findings.append({'start':start,'end':end,'type':rule['id'],'country':rule['country'],'validity':validity,'value':value})
            elif rule.get('sensitiveKeywords') and kw_near(text,start,end,rule['sensitiveKeywords']):
                findings.append({'start':start,'end':end,'type':rule['id']+'_LABELED_INVALID','country':rule['country'],'validity':'invalid_checksum_or_format_labeled','value':value})
    regions=set()
    for file in RULES.glob('*.json'):
        document=json.loads(file.read_text('utf8'))
        if document.get('phoneRegion') and (not country_set or document['country'] in country_set): regions.add(document['phoneRegion'])
    for region in sorted(regions):
        if region=='UNIVERSAL': continue
        for match in phonenumbers.PhoneNumberMatcher(text,region,leniency=phonenumbers.Leniency.VALID):
            if phonenumbers.is_valid_number(match.number):
                findings.append({'start':match.start,'end':match.end,'type':'PHONE_NUMBER','country':phonenumbers.region_code_for_number(match.number) or region,'validity':'phonenumbers_valid','value':match.raw_string})
    unique={(item['start'],item['end'],item['type'],item['country']):item for item in findings}
    return sorted(unique.values(),key=lambda item:(item['start'],item['end'],item['type']))

def presidio(text):
    global ANALYZER
    if ANALYZER is None:
        if importlib.util.find_spec('en_core_web_sm') is None: raise ValueError('PRESIDIO_MODEL_UNAVAILABLE')
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        engine=NlpEngineProvider(nlp_configuration={'nlp_engine_name':'spacy','models':[{'lang_code':'en','model_name':'en_core_web_sm'}]}).create_engine()
        ANALYZER=AnalyzerEngine(nlp_engine=engine,supported_languages=['en'])
    results=ANALYZER.analyze(text=text,language='en',score_threshold=.35)
    return [{'start':item.start,'end':item.end,'type':item.entity_type,'country':'PRESIDIO','validity':'presidio_score','score':item.score,'value':text[item.start:item.end]} for item in results]

def health():
    import phonenumbers, stdnum
    import importlib.metadata as md
    return {'python':sys.version.split()[0],'phonenumbers':phonenumbers.__version__,'pythonStdnum':stdnum.__version__,'presidioAnalyzer':md.version('presidio-analyzer'),'spacy':md.version('spacy'),'spacyModel':md.version('en-core-web-sm'),'networkDisabled':True,'ruleFiles':len(list(RULES.glob('*.json'))),'rulesHash':hashlib.sha256(b''.join(file.read_bytes() for file in sorted(RULES.glob('*.json')))).hexdigest()}

def process(request):
    action=request.get('action','scan'); started=time.perf_counter()
    if action=='health': return dict(status='ok',available=True,versions=health(),latencyMs=(time.perf_counter()-started)*1000)
    if action=='validate':
        rules=load_rules(); rule=next(item for item in rules if item['id']==request['type'])
        return {'status':'ok','valid':validate(request['value'],rule),'type':rule['id']}
    text=request.get('text','')
    if not isinstance(text,str) or len(text)>65536: raise ValueError('INPUT_LIMIT')
    findings=presidio(text) if action=='presidio' else scan(text,request.get('countries'))
    # Node slices use UTF-16 units; Python/NLP offsets count Unicode code points.
    for finding in findings:
        finding['start']=len(text[:finding['start']].encode('utf-16-le'))//2
        finding['end']=len(text[:finding['end']].encode('utf-16-le'))//2
    return {'status':'ok','available':True,'findings':findings,'latencyMs':(time.perf_counter()-started)*1000}

if __name__=='__main__':
    for line in sys.stdin:
        ident=None
        try:
            request=json.loads(line); ident=request.get('id'); result=process(request)
        except BaseException as error:
            code=str(error) if isinstance(error,ValueError) and re.fullmatch(r'[A-Z_]+',str(error)) else 'PRIVACY_WORKER_FAILURE'
            result={'status':'error','available':False,'failClosed':True,'code':code,'findings':[]}
        sys.stdout.write(json.dumps(dict(id=ident,**result),ensure_ascii=True)+'\n');sys.stdout.flush()
