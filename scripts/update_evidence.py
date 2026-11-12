#!/usr/bin/env python3
"""Only updates statuses when explicit evidence files exist; does not independently verify them."""
import argparse,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('test_id');p.add_argument('status',choices=['PASS','FAIL','BLOCKED','NOT_RUN']);p.add_argument('--evidence',action='append',default=[]);p.add_argument('--notes',default='');args=p.parse_args()
path=ROOT/'reports/ACCEPTANCE_STATUS.json';state=json.loads(path.read_text());item=state['tests'].get(args.test_id)
if item is None:sys.exit('Unknown test '+args.test_id)
if args.status=='PASS':
 if not args.evidence:sys.exit('Cannot PASS without evidence file')
 for x in args.evidence:
  f=(ROOT/x).resolve()
  if not f.is_file() or not f.is_relative_to(ROOT):sys.exit('Evidence file missing or outside repo '+x)
item.update({'status':args.status,'evidence':args.evidence,'notes':args.notes})
path.write_text(json.dumps(state,indent=2)+'\n')
print(args.test_id,args.status)
