"""Independent, dependency-free reference ORACLE for selected demo rule outcomes.

This is a test oracle, NOT the product rule engine, production-composition logic,
or a replacement for the approved requirements. Keep it independent of application
code. It intentionally covers only the seeded rule AST operators and sample rules.
"""
from __future__ import annotations
import copy, hashlib, json
from pathlib import Path
from typing import Any

ROOT=Path(__file__).resolve().parents[1]
FIX=ROOT/'fixtures'

def load(name: str):
    return json.loads((FIX/name).read_text(encoding='utf-8'))


def canon(x: Any) -> str:
    return json.dumps(x,sort_keys=True,ensure_ascii=False,separators=(',',':'))


def digest(x: Any) -> str:
    return hashlib.sha256(canon(x).encode('utf-8')).hexdigest()


def deep_patch(value: dict, patch: dict):
    for k,v in patch.items():
        if isinstance(v,dict) and isinstance(value.get(k),dict):
            deep_patch(value[k],v)
        else:
            value[k]=copy.deepcopy(v)
    return value


def path_value(ctx: dict, path: str):
    parts=path.split('.')
    if parts[-1]=='count':
        container=path_value(ctx,'.'.join(parts[:-1]))
        return len(container) if isinstance(container,(list,dict)) else None
    value=ctx
    for p in parts:
        if not isinstance(value,dict) or p not in value:
            return None
        value=value[p]
    return value


def predicate(expression: dict, ctx: dict)-> bool:
    op=expression['op']
    if op=='and': return all(predicate(p,ctx) for p in expression['args'])
    if op=='or': return any(predicate(p,ctx) for p in expression['args'])
    if op=='not': return not predicate(expression['arg'],ctx)
    field=path_value(ctx,expression['path'])
    val=expression.get('value')
    if op=='eq': return field==val and field is not None
    if op=='ne': return field!=val and field is not None
    if op=='gt': return field is not None and field>val
    if op=='gte': return field is not None and field>=val
    if op=='lt': return field is not None and field<val
    if op=='lte': return field is not None and field<=val
    if op=='in': return field in val
    raise ValueError('Unknown rule AST operator '+op)


def resolve(record: dict, project: dict|None=None, rules: list|None=None, overrides: dict|None=None, claim_index: int=0)->dict:
    record=copy.deepcopy(record)
    if overrides: deep_patch(record,overrides)
    if project is None:
        project=next(p for p in load('projects.json') if p['documentType']==record['documentType'])
    if rules is None: rules=load('rules_20.json')
    doc_type=record['documentType']
    claim=None
    if doc_type=='eob':
        claims=record.get('claims',[])
        claim=claims[claim_index] if claim_index<len(claims) else None
    ctx=copy.deepcopy(record)
    ctx['claim']=claim or {}
    doc_nodes={n['id']:n for n in project['nodes']}
    matched=[]; trace=[]; exclusive={}; selected={}; additive=[]; mandatory=[]; diagnostics=[]
    for rule in rules:
        if rule['scope']!=doc_type: continue
        is_match=predicate(rule['when'],ctx)
        trace.append({'ruleId':rule['id'],'matched':is_match})
        if not is_match: continue
        matched.append(rule['id'])
        mode=rule['mode']
        if mode=='exclusive':
            exclusive.setdefault(rule['exclusiveGroup'],[]).append(rule)
        elif mode=='obligation':
            required=rule['then'].get('nodeIds',[])
            mandatory.extend(required)
            for node in required:
                if node not in doc_nodes:
                    diagnostics.append({'code':'REQUIRED_NODE_MISSING','severity':'blocking','nodeId':node,'ruleId':rule['id']})
        elif mode=='additive':
            additive.append(rule['id'])
        else: raise ValueError('Unexpected rule mode '+mode)

    for node in project['nodes']:
        if node.get('type')!='variant-set':continue
        group=node['id']
        hits=sorted(exclusive.get(group,[]),key=lambda r:r['priority'],reverse=True)
        if hits and len(hits)>1 and hits[0]['priority']==hits[1]['priority']:
            diagnostics.append({'code':'EXCLUSIVE_PRIORITY_TIE','severity':'blocking','nodeId':group,'ruleIds':[r['id'] for r in hits if r['priority']==hits[0]['priority']]})
            selected[group]=None
        elif hits:
            selected[group]=hits[0]['then']['variantId']
        elif node.get('fallbackVariantId'):
            selected[group]=node['fallbackVariantId']
        else:
            selected[group]=None
            diagnostics.append({'code':'NO_VARIANT_MATCH','severity':'blocking','nodeId':group})

    if doc_type=='credit-statement':
        card=record['card']
        if card.get('paymentStatus')=='current' and card.get('missedPayments',0)>0:
            diagnostics.append({'code':'INCONSISTENT_PAYMENT_STATE','severity':'blocking','nodeId':'payment-guidance'})
        if card.get('newBalanceCents') != card.get('previousBalanceCents',0)+card.get('purchasesCents',0)-card.get('paymentsCreditsCents',0)+card.get('interestFeesCents',0):
            diagnostics.append({'code':'BALANCE_RECONCILIATION_FAILED','severity':'blocking','nodeId':'billing-summary'})
    elif doc_type=='eob' and claim:
        if claim['status']=='denied-pending-review' and not claim.get('liabilityConfirmed',False) and claim.get('patientResponsibilityCents',0)>0:
            diagnostics.append({'code':'UNCONFIRMED_MEMBER_LIABILITY','severity':'blocking','nodeId':'totals-and-terms'})
        if claim['status']=='processed-covered':
            if claim['billedCents'] != claim['allowedCents'] + claim['contractualAdjustmentCents'] or claim['allowedCents']!=claim['planPaidCents']+claim['patientResponsibilityCents']:
                diagnostics.append({'code':'CLAIM_RECONCILIATION_FAILED','severity':'blocking','nodeId':'totals-and-terms'})

    if 'R07' in matched:
        parts={p['id']:p for p in load('content_parts_30.json')}
        required_content=set(mandatory)
        required_content.update(v for v in selected.values() if v)
        for part_id in sorted(required_content):
            if part_id in parts and record['customer']['locale'] not in parts[part_id].get('approvedLocales',{}):
                diagnostics.append({'code':'REQUIRED_TRANSLATION_MISSING','severity':'blocking','nodeId':part_id,'locale':record['customer']['locale']})

    summary={'recordId':record['recordId'],'documentType':doc_type,
        'selectedVariants':selected,'matchedRuleIds':sorted(matched),
        'additiveRuleIds':sorted(additive),'requiredNodes':sorted(set(mandatory)),
        'diagnostics':sorted(diagnostics,key=lambda x:(x['code'],x.get('nodeId',''))),
        'documentFacts':(
          {'newBalanceCents':record['card']['newBalanceCents'],'minimumDueCents':record['card']['minimumDueCents'],'transactionCount':len(record['card']['transactions'])}
          if doc_type=='credit-statement' else
          {'claimId':claim['claimId'] if claim else None,'billedCents':claim['billedCents'] if claim else None,'allowedCents':claim['allowedCents'] if claim else None,'planPaidCents':claim['planPaidCents'] if claim else None,'patientResponsibilityCents':claim['patientResponsibilityCents'] if claim else None,'liabilityConfirmed':claim['liabilityConfirmed'] if claim else None,'notABill':True}
        )}
    summary['resultDigest']=digest(summary)
    return summary


def scenario_cases() -> list[tuple[str,dict,dict|None,dict|None]]:
    all_records=load('customers_100.json')
    ids={r['recordId']:r for r in all_records['creditCard']+all_records['healthcareEob']}
    def c(id,key,overrides=None): return (key,ids[id],overrides,None)
    cases=[
      c('CARD-0001','card-standard'),c('CARD-0002','card-assistance'),
      c('EOB-0001','eob-covered'),c('EOB-0002','eob-under-review'),
      c('CARD-0001','card-missed-first',{'card':{'missedPayments':1,'paymentStatus':'overdue'}}),
      c('CARD-0001','card-assistance-requested',{'card':{'missedPayments':2,'paymentStatus':'overdue','assistanceRequested':True}}),
      c('CARD-0001','card-arrangement-approved',{'card':{'missedPayments':2,'paymentStatus':'overdue','assistanceRequested':True,'arrangementStatus':'approved'}}),
      c('CARD-0001','card-spanish-missing-mandatory-translation',{'customer':{'locale':'es-US'}}),
      c('CARD-0001','card-inconsistent-payment-state',{'card':{'missedPayments':2,'paymentStatus':'current'}}),
      c('EOB-0002','eob-unconfirmed-liability',{'claims':[dict(ids['EOB-0002']['claims'][0],patientResponsibilityCents=30000)]}),
    ]
    # Build a 250-row stress fixture that preserves the $508.00 purchase sum.
    tx=[]
    for i in range(250):
        tx.append({'id':f'STRESS-{i+1:04}', 'date':'2026-10-15','merchant':f'Synthetic transaction {i+1:03}', 'amountCents':204 if i<50 else 203})
    assert sum(t['amountCents'] for t in tx)==50800
    cases.append(c('CARD-0001','card-250-rows',{'card':{'transactions':tx}}))
    return cases


def cases_to_goldens():
    out={}
    for name,record,overrides,_ in scenario_cases():
        res=resolve(record,overrides=overrides)
        out[name]={'recordId':record['recordId'],'overrides':overrides or {},'expected':res}
    # Explicit tie defect: adjust R03 to match assistance_requested and its priority to 400.
    rules=load('rules_20.json')
    for r in rules:
        if r['id']=='R03':
            r['when']={'op':'gte','path':'card.missedPayments','value':2}
            r['priority']=400
    rec=next(r for r in load('customers_100.json')['creditCard'] if r['recordId']=='CARD-0002')
    out['card-tie-defect']={'recordId':'CARD-0002','overrides':{},'rulePatches':[{'id':'R03','when':{'op':'gte','path':'card.missedPayments','value':2},'priority':400}], 'expected':resolve(rec,rules=rules)}
    return out

if __name__=='__main__':
    print(json.dumps(cases_to_goldens(),indent=2))
