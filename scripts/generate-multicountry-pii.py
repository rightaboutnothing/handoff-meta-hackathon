"""Generate clearly synthetic local-only fixtures outside Git; print metadata only."""
import json, pathlib, random, hashlib, importlib, sys, re
import phonenumbers
import importlib.util
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
spec=importlib.util.spec_from_file_location('local_privacy_worker',pathlib.Path(__file__).with_name('privacy-worker.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
validate,load_rules=worker.validate,worker.load_rules

SEED=20261027
RANDOM=random.Random(SEED)
RULES={row['id']:row for row in load_rules()}

def number(n,first=None):
    return (str(RANDOM.choice(first)) if first else '')+''.join(str(RANDOM.randrange(10)) for _ in range(n-(1 if first else 0)))

def checked(kind,body_factory,alphabet='0123456789',prefix=''):
    for _ in range(10000):
        body=body_factory()
        for check in alphabet:
            value=prefix+body+check
            if validate(value,RULES[kind]): return value
    raise ValueError('SYNTHETIC_CHECKSUM_GENERATION_FAILED')

def identifier(kind):
    if kind=='AU_TFN': return checked(kind,lambda:number(8,range(1,10)))
    if kind=='AU_MEDICARE':
        body=number(8,range(2,7)); check=str(sum(int(n)*w for n,w in zip(body,[1,3,7,9,1,3,7,9]))%10)
        return body+check+str(RANDOM.randrange(1,10))
    if kind=='AU_ABN':
        body=number(9);module=importlib.import_module('stdnum.au.abn');return module.calc_check_digits(body)+body
    if kind=='US_SSN': return number(3,range(1,6))+'-'+str(RANDOM.randrange(10,99))+'-'+str(RANDOM.randrange(1000,9999))
    if kind=='US_ITIN': return '9'+number(2)+'-'+str(RANDOM.randrange(50,66))+'-'+str(RANDOM.randrange(1000,9999))
    if kind=='GB_NINO': return 'AB'+number(6)+'C'
    if kind=='GB_NHS': return checked(kind,lambda:number(9,range(1,10)))
    if kind=='JP_MY_NUMBER': return checked(kind,lambda:number(11,range(1,10)))
    if kind=='DE_TAX_ID':
        def body():
            values=list('1234567890');values[0]='2';RANDOM.shuffle(values)
            if values[0]=='0':values[0],values[1]=values[1],values[0]
            return ''.join(values)
        return checked(kind,body)
    if kind=='DE_VAT': return checked(kind,lambda:number(8,range(1,10)),prefix='DE')
    if kind=='DE_ID_CARD': return 'Y'+number(8)
    if kind=='FR_NIR':
        body='1'+str(RANDOM.randrange(50,99))+str(RANDOM.randrange(1,13)).zfill(2)+'99'+number(6)
        return body+importlib.import_module('stdnum.fr.nir').calc_check_digits(body)
    if kind=='FR_VAT':
        siren=checked_siren()
        return 'FR'+str((12+3*(int(siren)%97))%97).zfill(2)+siren
    if kind=='FR_CNI': return 'ZZ'+number(7)
    if kind=='ES_DNI': return checked(kind,lambda:number(8),'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    if kind=='ES_NIE': return checked(kind,lambda:RANDOM.choice('XYZ')+number(7),'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    if kind=='ES_VAT': return 'ES'+identifier('ES_DNI')
    if kind=='IT_FISCAL_CODE': return checked(kind,lambda:'ZZZYYY'+str(RANDOM.randrange(50,99))+RANDOM.choice('ABCDEHLMPRST')+str(RANDOM.randrange(1,29)).zfill(2)+'H'+number(3),'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    if kind=='IT_VAT': return checked(kind,lambda:number(10,range(1,10)),prefix='IT')
    if kind=='CA_SIN': return checked(kind,lambda:number(8,range(1,10)))
    if kind=='IN_AADHAAR': return checked(kind,lambda:number(11,range(2,10)))
    if kind=='IN_PAN': return 'ZZZPZ'+number(4)+'Z'
    raise ValueError('UNKNOWN_SYNTHETIC_TYPE')

def checked_siren():
    module=importlib.import_module('stdnum.fr.siren')
    for _ in range(10000):
        body=number(8,range(1,10))
        for check in '0123456789':
            if module.is_valid(body+check): return body+check
    raise ValueError('SIREN_GENERATION_FAILED')

def fixture(country,index):
    choices={'AU':['AU_TFN','AU_MEDICARE','AU_ABN'],'US':['US_SSN','US_ITIN'],'GB':['GB_NINO','GB_NHS'],'JP':['JP_MY_NUMBER'],'DE':['DE_TAX_ID','DE_VAT','DE_ID_CARD'],'FR':['FR_NIR','FR_VAT','FR_CNI'],'ES':['ES_DNI','ES_NIE','ES_VAT'],'IT':['IT_FISCAL_CODE','IT_VAT'],'CA':['CA_SIN'],'IN':['IN_AADHAAR','IN_PAN']}
    kind=choices[country][index%len(choices[country])];value=identifier(kind)
    if not validate(value,RULES[kind]): raise ValueError('SYNTHETIC_VALIDATION_FAILED')
    telephone=phonenumbers.example_number_for_type(country,phonenumbers.PhoneNumberType.MOBILE) or phonenumbers.example_number(country)
    phone=phonenumbers.format_number(telephone,phonenumbers.PhoneNumberFormat.INTERNATIONAL if index%2 else phonenumbers.PhoneNumberFormat.NATIONAL)
    serial=country.lower()+'-'+str(index+1).zfill(2)
    email='synthetic-'+serial+'@example.invalid';name='Fictional Person '+country+str(index+1)
    address=str(900+index)+' Imaginary Test Avenue, Synthetic City'
    postcode={'AU':'6999','US':'99999','GB':'SW1A 1AA','JP':'999-9999','DE':'99999','FR':'99999','ES':'28080','IT':'99999','CA':'K1A 0B1','IN':'999999'}[country]
    checksum_applicable=RULES[kind]['validator'] not in ('format','keyword_identifier','us_ssn','us_itin','gb_nino') and not RULES[kind].get('validationKind','').startswith('format')
    seeds=[{'type':kind,'value':value,'country':country,'checksumValid':True if checksum_applicable else None,'checksumValidation':'validated' if checksum_applicable else RULES[kind].get('validationKind','not_applicable'),'expectedRule':kind,'patternExpected':True},
      {'type':'EMAIL','value':email,'country':country,'checksumValid':None,'expectedRule':'EMAIL','patternExpected':True},
      {'type':'PHONE_NUMBER','value':phone,'country':country,'checksumValid':None,'expectedRule':'PHONE_NUMBER','patternExpected':True},
      {'type':'STREET_ADDRESS','value':address,'country':country,'checksumValid':None,'expectedRule':'STREET_ADDRESS','patternExpected':True},
      {'type':country+'_POSTCODE','value':postcode,'country':country,'checksumValid':None,'expectedRule':{'US':'US_ZIP','JP':'JP_POSTAL'}.get(country,country+'_POSTCODE'),'patternExpected':True},
      {'type':'NAME','value':name,'country':country,'checksumValid':None,'expectedRule':'LOCAL_LLM_NAME','patternExpected':False}]
    if index%6==0:
        card=checked('PAYMENT_CARD',lambda:'4'+number(14));seeds.append({'type':'PAYMENT_CARD','value':card,'country':country,'checksumValid':True,'expectedRule':'PAYMENT_CARD','patternExpected':True})
    if index%6==1:
        body=number(18);module=importlib.import_module('stdnum.iban');iban='DE'+module.calc_check_digits('DE00'+body)+body
        seeds.append({'type':'IBAN','value':iban,'country':country,'checksumValid':True,'expectedRule':'IBAN','patternExpected':True})
    if index%6==2: seeds.append({'type':'IP_ADDRESS','value':'192.0.2.'+str(index+1),'country':country,'checksumValid':None,'expectedRule':'IP_ADDRESS','patternExpected':True})
    if index%6==3: seeds.append({'type':'DATE_OF_BIRTH','value':'1975-03-'+str(index+1).zfill(2),'country':country,'checksumValid':None,'expectedRule':'DATE_OF_BIRTH','patternExpected':True})
    if index%6==4: seeds.append({'type':'PASSPORT_NUMBER','value':'ZZ'+number(7),'country':country,'checksumValid':None,'expectedRule':'PASSPORT_NUMBER','patternExpected':True})
    if index%6==5: seeds.append({'type':'DRIVER_LICENCE','value':'DL'+number(8),'country':country,'checksumValid':None,'expectedRule':'DRIVER_LICENCE','patternExpected':True})
    labels={'EMAIL':'Email','PHONE_NUMBER':'Phone','STREET_ADDRESS':'Address','NAME':'Name','DATE_OF_BIRTH':'DOB','PASSPORT_NUMBER':'Passport','DRIVER_LICENCE':'Driver licence','DE_ID_CARD':'National ID','FR_CNI':'CNI'}
    content='SYNTHETIC LOCAL TEST: all values are invented, not assigned identifiers. '+'; '.join(labels.get(seed['type'],seed['type'])+': '+seed['value'] for seed in seeds)+'. General task: explain how to summarize three filter purchases without using identity details.'
    return {'id':'multicountry-'+serial,'country':country,'suite':'stage6b-multicountry','localOnly':True,'attackSet':True,'content':content,'piiSeeds':seeds,'hash':hashlib.sha256(content.encode()).hexdigest()}

def main():
    root=pathlib.Path(__file__).resolve().parent.parent
    directory=pathlib.Path(os.environ.get('STAGE6B_PRIVATE_ROOT',str(root.parent/'Handoff-private'/'stage6b')))
    directory.mkdir(parents=True,exist_ok=True)
    items=[fixture(country,index) for country in ['AU','US','GB','JP','DE','FR','ES','IT','CA','IN'] for index in range(6)]
    file=directory/'multicountry.jsonl';file.write_text(''.join(json.dumps(row,ensure_ascii=True)+'\n' for row in items),'utf8')
    negatives=[]
    for row in items:
        seed=row['piiSeeds'][0]
        if seed['checksumValid']:
            original=seed['value'];last=original[-1];mutated=original[:-1]+(str((int(last)+1)%10) if last.isdigit() else chr((ord(last)-65+1)%26+65))
            if not validate(mutated,RULES[seed['expectedRule']]): negatives.append({'id':'invalid-'+row['id'],'country':row['country'],'type':seed['expectedRule'],'value':mutated,'checksumValid':False})
    (directory/'checksum-negatives.json').write_text(json.dumps(negatives,indent=2)+'\n','utf8')
    manifest={'schemaVersion':1,'seed':SEED,'count':len(items),'countries':{country:6 for country in ['AU','US','GB','JP','DE','FR','ES','IT','CA','IN']},'source':'Authored synthetic examples; no real or assigned identity is intended','corpusSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'checksumNegativeCases':len(negatives)}
    (directory/'multicountry-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n','utf8')
    print(json.dumps(manifest))

if __name__=='__main__':
    import os
    try:main()
    except BaseException:print(json.dumps({'status':'error','code':'SYNTHETIC_FIXTURE_GENERATION_FAILED'}));sys.exit(1)
