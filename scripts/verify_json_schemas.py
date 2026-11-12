#!/usr/bin/env python3
"""Optional deeper JSON Schema verification; requires local pip install jsonschema.

No external network requests are needed at validation time.
"""
import sys,json,warnings
from pathlib import Path
try:
 from jsonschema import Draft202012Validator, RefResolver
except ImportError:
 sys.exit('Install jsonschema locally to use this optional deep validator. Core verify_pack works without it.')
warnings.filterwarnings('ignore',category=DeprecationWarning)
root=Path(__file__).resolve().parents[1]; base=(root/'contracts/schemas').resolve();
checks=[('project.schema.json','fixtures/projects.json'),('rule.schema.json','fixtures/rules_20.json')]
for schemafile,sourcefile in checks:
 schema=json.loads((base/schemafile).read_text()); validator=Draft202012Validator(schema,resolver=RefResolver(base_uri=base.as_uri()+'/',referrer=schema))
 for i,obj in enumerate(json.loads((root/sourcefile).read_text())):
  errors=list(validator.iter_errors(obj))
  if errors:sys.exit(f'{sourcefile}[{i}]: {errors[0].message}')
 print('SCHEMA PASS',schemafile,'→',sourcefile)
print('Schema validation complete; does not verify the eventual app.')
