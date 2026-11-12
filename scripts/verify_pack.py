#!/usr/bin/env python3
"""Verify this handoff pack is intact. Does NOT verify a built app."""
from pathlib import Path
import hashlib,json,subprocess,sys,unittest

ROOT=Path(__file__).resolve().parents[1]
required=['START_HERE.md','AGENTS.md','CLAUDE.md','BUILD_CONTRACT.md','execution/ONE_SHOT_PROMPT.md',
'execution/MILESTONE_GATES.md','execution/TECH_STACK_AND_ADRS.md','execution/SECURITY_AND_AI.md',
'contracts/SCREEN_CONTRACT.json','contracts/ACCEPTANCE_MATRIX.json','contracts/API_CONTRACT.md',
'fixtures/customers_100.json','fixtures/expected_scenarios.json','oracle/reference_resolver.py',
'fixtures/projects.json','reference/UX_ATLAS.html','docs/approved/PRODUCT_SPEC.md',
'docs/approved/UX_BLUEPRINT.md','docs/approved/IMPLEMENTATION_PLAN.md']

def main():
 errors=[]
 for p in required:
  if not (ROOT/p).is_file():errors.append(f'missing {p}')
 try:
  manifest=json.loads((ROOT/'ASSET_MANIFEST.json').read_text(encoding='utf-8'))
  for row in manifest['files']:
   p=ROOT/row['path']
   if not p.is_file():errors.append('manifest missing '+row['path']);continue
   actual=hashlib.sha256(p.read_bytes()).hexdigest()
   if actual!=row['sha256']:errors.append('hash mismatch '+row['path'])
 except Exception as e:errors.append('manifest error '+str(e))
 pics=sorted((ROOT/'reference/screenshots').glob('screen-*.png'))
 if len(pics)!=12: errors.append('expected 12 visual reference screenshots, saw '+str(len(pics)))
 for p in (ROOT/'contracts').rglob('*.json'):
  try:json.loads(p.read_text(encoding='utf-8'))
  except Exception as e:errors.append('bad JSON '+str(p)+' '+str(e))
 if errors:
  print('PACK VALIDATION: FAIL')
  for e in errors:print(' -',e)
  return 1
 # Run independent tests in fresh subprocess; test outcome is never inferred.
 cmd=[sys.executable,'-m','unittest','discover','-s',str(ROOT/'tests'),'-p','test_*.py','-v']
 result=subprocess.run(cmd,cwd=ROOT)
 if result.returncode:
  print('PACK VALIDATION: FAIL, independent tests failed')
  return result.returncode
 print('PACK VALIDATION: PASS — inputs, test oracle, contracts and reference assets only. APP NOT YET VERIFIED.')
 return 0

if __name__=='__main__':sys.exit(main())
