#!/usr/bin/env python3
"""Actual-service smoke/contract checker. Missing app is a hard FAIL.

This cannot replace the browser Playwright suite or detailed 36 acceptance checks.
"""
from pathlib import Path
import argparse,copy,json,urllib.request,urllib.error,sys

ROOT=Path(__file__).resolve().parents[1]

class Probe:
 def __init__(self,base):self.base=base.rstrip('/');self.passed=0;self.failed=[]
 def request(self,method,path,payload=None,timeout=75):
  data=None if payload is None else json.dumps(payload).encode()
  req=urllib.request.Request(self.base+path,data=data,method=method,headers={'Content-Type':'application/json','Accept':'*/*'})
  with urllib.request.urlopen(req,timeout=timeout) as response:
   return response.status,response.headers,response.read()
 def check(self,label,ok,detail=''):
  if ok:print('PASS',label);self.passed+=1
  else:print('FAIL',label,detail);self.failed.append(label+' '+detail)

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--base-url',default='http://127.0.0.1:3001');ap.add_argument('--web-url',default='http://127.0.0.1:5173');args=ap.parse_args();p=Probe(args.base_url)
 try:
  status,_,body=p.request('GET','/api/v1/health',timeout=5)
  h=json.loads(body);p.check('actual API health',status==200 and h.get('status')=='ok',repr(h))
 except Exception as e:
  print('APP VERIFICATION: FAIL — no usable running API at',args.base_url,'\n',repr(e));return 1
 try:
  status,_,body=p.request('GET','/api/v1/projects'); projects=json.loads(body).get('projects',[])
  ids={x['projectId'] for x in projects};p.check('two seeded projects',{'aster-card-demo','harborcare-demo'}.issubset(ids),repr(ids))
 except Exception as e:p.check('two seeded projects',False,repr(e))
 data=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
 for name,case in data.items():
  if 'rulePatches' in case:continue # This scenario is tested by rule editor/E2E rather than untrusted public API patch.
  project='aster-card-demo' if case['recordId'].startswith('CARD') else 'harborcare-demo'
  payload={'projectId':project,'recordId':case['recordId'],'overrides':case['overrides'],'outputContext':{'profileId':'paged-pdf'},'journeyCursor':None}
  try:
   status,_,body=p.request('POST','/api/v1/resolve',payload)
   response=json.loads(body); got=response['result']; expected=case['expected']
   keys=['recordId','documentType','selectedVariants','matchedRuleIds','additiveRuleIds','requiredNodes','diagnostics','documentFacts']
   diffs={k:{'got':got.get(k),'expected':expected[k]} for k in keys if got.get(k)!=expected[k]}
   p.check('resolver '+name,status==200 and not diffs,repr(diffs)[:700])
  except Exception as e:p.check('resolver '+name,False,repr(e)[:450])
 # Real composition, not prepacked artefact. Fully verify detailed pagination in Playwright/composer unit suite.
 for fmt in ('pdf','html'):
  body_data={'projectId':'aster-card-demo','recordId':'CARD-0001','overrides':{},'outputContext':{'profileId':'paged-pdf' if fmt=='pdf' else 'html-responsive'}}
  try:
   status,headers,data_bytes=p.request('POST','/api/v1/compose/'+fmt,body_data,timeout=75)
   ok=(status==200 and len(data_bytes)>2000)
   if fmt=='pdf':
    ok=ok and data_bytes.startswith(b'%PDF-') and 'pdf' in headers.get('Content-Type','').lower()
    try:
     from pypdf import PdfReader
     from io import BytesIO
     reader=PdfReader(BytesIO(data_bytes));txt='\n'.join(page.extract_text() for page in reader.pages)
     ok=ok and len(reader.pages)>=1 and ('$1,248' in txt or '1,248' in txt)
    except ImportError:print('NOTE pypdf unavailable; app acceptance still needs PDF text tests')
   else:
    text=data_bytes.decode('utf-8',errors='replace').lower();ok=ok and '<html' in text and '<table' in text and '<script' in text
   p.check(fmt+' real binary/text export',ok,'size='+str(len(data_bytes)))
  except Exception as e:p.check(fmt+' real export',False,repr(e))
 # 250 rows must be real pages; fail if PDF claims success without more than one page.
 stress=data['card-250-rows']
 try:
  status,headers,raw=p.request('POST','/api/v1/compose/pdf',{'projectId':'aster-card-demo','recordId':stress['recordId'],'overrides':stress['overrides'],'outputContext':{'profileId':'paged-pdf'}},timeout=120)
  from pypdf import PdfReader
  from io import BytesIO
  pdf=PdfReader(BytesIO(raw));txt='\n'.join(page.extract_text() or '' for page in pdf.pages)
  p.check('250-row actual PDF continuation',status==200 and len(pdf.pages)>1 and 'STRESS-0001' in txt and 'STRESS-0250' in txt,f'pages={len(pdf.pages)}')
 except Exception as e:p.check('250-row actual PDF continuation',False,repr(e))
 try:
  _,_,raw=p.request('POST','/api/v1/compose/afp-sim',{'projectId':'aster-card-demo','recordId':'CARD-0001','outputContext':{'profileId':'paged-afp-sim'}})
  sim=json.loads(raw);p.check('AFP explicitly simulation only',sim.get('simulationOnly') is True and b'AFP' not in raw[:8],repr(sim)[:180])
 except Exception as e:p.check('AFP explicitly simulation only',False,repr(e))
 try:
  with urllib.request.urlopen(args.web_url+'/projects',timeout=6) as resp:raw=resp.read().decode('utf-8',errors='replace')
  p.check('actual web frontend reachable','<html' in raw.lower(),repr(raw[:60]))
 except Exception as e:p.check('actual web frontend reachable',False,repr(e))
 print(f'APP VERIFICATION: {p.passed} pass, {len(p.failed)} fail. This is smoke verification, not the complete acceptance suite.')
 return 1 if p.failed else 0
if __name__=='__main__':sys.exit(main())
