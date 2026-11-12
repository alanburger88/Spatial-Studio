import json,random,re,hashlib,zipfile
from pathlib import Path
from datetime import date,timedelta
root=Path('/mnt/data/spatial_studio_work/fixtures')
root.mkdir(parents=True,exist_ok=True)
rng=random.Random(20261112)
def dump(name,obj):
    (root/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf8')

personas=[
('P01','Everyday','en-US','standard','current','email',12),
('P02','Premier','en-US','premium','current','email',16),
('P03','First Missed Payment','en-US','standard','overdue','email',22),
('P04','Financial Assistance','en-US','standard','overdue','email',45),
('P05','Spanish Preferred','es-US','standard','current','email',18),
('P06','Digital First','en-US','standard','current','digital',13),
('P07','Paper Preferred','en-US','standard','current','print',12),
('P08','High Volume','en-US','standard','current','email',250),
('P09','New Cardholder','en-US','standard','current','digital',1),
('P10','Accessibility Focus','en-US','standard','current','email',12),
('P11','Rewards Focus','en-US','premium','current','email',24),
('P12','Edge-Case Customer','en-US','standard','current','email',7)
]
persona_json=[{'id':p,'name':n,'sampleOverrides':{'customer':{'locale':l,'accessibility':{'largeText':p=='P10','highContrast':p=='P10'}},'card':{'tier':tier,'paymentStatus':status,'channelPreference':channel,'transactionCount':count,'missedPayments':2 if p=='P04' else (1 if p=='P03' else 0),'assistanceRequested':p=='P04','rewardsBalance':1800 if p=='P11' else 0}}} for p,n,l,tier,status,channel,count in personas]
dump('personas.json',persona_json)

first_names=['Jordan','Taylor','Alex','Casey','Morgan','Avery','Sam','Charlie','Harper','Quinn','Jamie','Reese','Riley','Emery','Drew','Cameron','Dakota','Skyler']
last_names=['Mercer','Rivers','Chen','Patel','Santos','Lee','Brooks','Mills','Foster','Stone','Reed','Grant','Park','Navarro','Bennett','Cole']
merchants=['Maple Groceries','Harbor Fuel','South Bay Pharmacy','Riverside Books','Aster Coffee','Seaside Market','Atlas Office Supply','Transit Pass','Demo Streaming','City Parking']

# Ensure all financial fixtures are internally reconciled and stable.
def transactions_for(i,count,amount_total):
    if count==0:return []
    base=amount_total//count
    vals=[base]*count
    for j in range(amount_total-base*count):vals[j]+=1
    rng.shuffle(vals)
    start=date(2026,10,1)
    return [{'id':f'T-{i:03d}-{j+1:04d}','date':str(start+timedelta(days=j%31)),'merchant':merchants[(i+j)%len(merchants)],'amountCents':amt} for j,amt in enumerate(vals)]

cards=[]
for i in range(70):
    p=personas[i%12]
    pid,name,locale,tier,status,channel,count=p
    given=first_names[i%len(first_names)]; family=last_names[i%len(last_names)]
    prev=100000 + 7000*(i%7)
    purchases=50800 if i==0 else count*1695
    payment=30000 if i==0 else min(25000,prev//4)
    interest=0
    balance=prev+purchases-payment+interest
    misses=2 if pid=='P04' else (1 if pid=='P03' else 0)
    request=pid=='P04'
    if i==0:
        given,family,prev,purchases,payment,balance,count='Jordan','Mercer',104000,50800,30000,124800,12
    if i==3:
        given,family,prev,purchases,payment,balance,count='Taylor','Rivers',220000,66000,20000,266000,45
    trans=transactions_for(i+1,count,purchases)
    cards.append({'recordId':f'CARD-{i+1:04d}','documentType':'credit-statement','personaId':pid,
      'customer':{'givenName':given,'familyName':family,'locale':locale,'accessibility':{'largeText':pid=='P10','highContrast':pid=='P10'},'synthetic':True},
      'card':{'maskedAccount':f'•••• {1842 if i==0 else (9027 if i==3 else (1000+73*i))}',
       'statementStart':'2026-10-01','statementEnd':'2026-10-31','issuedAt':'2026-11-01','dueDate':'2026-11-25','currency':'USD',
       'creditLimitCents':800000,'previousBalanceCents':prev,'purchasesCents':purchases,'paymentsCreditsCents':payment,'interestFeesCents':interest,
       'newBalanceCents':balance,'minimumDueCents':4500 if i==0 else min(9400,max(2500,balance//25)),
       'tier':tier,'paymentStatus':status,'missedPayments':misses,'assistanceRequested':request,'arrangementStatus':'none',
       'channelPreference':channel,'rewardsBalance':1800 if pid=='P11' else 0,
       'transactions':trans},'demonstrationOnly':True})
# override second canonical special fixture to agreed assistance value
cards[1]['recordId']='CARD-0002';cards[1]['personaId']='P04';cards[1]['customer']['givenName']='Taylor';cards[1]['customer']['familyName']='Rivers';cards[1]['card'].update({'maskedAccount':'•••• 9027','paymentStatus':'overdue','missedPayments':2,'assistanceRequested':True,'newBalanceCents':246000,'minimumDueCents':9400,'previousBalanceCents':220000,'purchasesCents':46000,'paymentsCreditsCents':20000,'interestFeesCents':0,'transactions':transactions_for(2,45,46000)})
# Set original 4th customer to everyday (avoid duplicate meant for assistance) and valid reconciliation
cards[3]['card']['paymentStatus']='overdue'
# EOB fixtures: billed = contractual adjustment + allowed; allowed = plan paid + patient amount on processed cases.
claim_statuses=['processed-covered','deductible-applied','out-of-network-review','denied-pending-review','appeal-filed','processed-covered']
eobs=[]
for i in range(30):
    st=claim_statuses[i%len(claim_statuses)]
    billed=40000 + (i%5)*3500
    allowed=25000 + (i%4)*2500
    plan=round(allowed*.8)
    patient=allowed-plan
    adjustment=billed-allowed
    if st in ('denied-pending-review','appeal-filed'):
        allowed=plan=patient=0;adjustment=0
    eobs.append({'recordId':f'EOB-{i+1:04d}','documentType':'eob','customer':{'givenName':first_names[(i+4)%len(first_names)],'familyName':last_names[(i+5)%len(last_names)],'locale':'en-US','synthetic':True},
      'member':{'planName':'HarborCare Select','memberId':f'HC-MBR-{8000+i}'},
      'claims':[{'claimId':f'HC-{10428+i}','serviceDate':str(date(2026,10,18)+timedelta(days=i%9)), 'service':'Office visit' if i%2==0 else 'Diagnostic laboratory',
        'billedCents':billed,'allowedCents':allowed,'contractualAdjustmentCents':adjustment,
        'planPaidCents':plan,'patientResponsibilityCents':patient,'liabilityConfirmed':st not in ('denied-pending-review','appeal-filed'),
        'status':st,'network':'out-of-network' if st=='out-of-network-review' else 'in-network',
        'deductibleAppliedCents':patient if st=='deductible-applied' else 0,
        'amountUnderReviewCents':billed if st in ('denied-pending-review','appeal-filed') else 0}],
      'demonstrationOnly':True})
eobs[0]['customer'].update({'givenName':'Morgan','familyName':'Lee'})
eobs[0]['claims'][0].update({'claimId':'HC-10428','billedCents':40000,'allowedCents':25000,'contractualAdjustmentCents':15000,'planPaidCents':20000,'patientResponsibilityCents':5000,'status':'processed-covered','liabilityConfirmed':True})
eobs[1]['customer'].update({'givenName':'Avery','familyName':'Stone'})
eobs[1]['claims'][0].update({'claimId':'HC-10429','service':'Diagnostic laboratory','billedCents':30000,'allowedCents':0,'contractualAdjustmentCents':0,'planPaidCents':0,'patientResponsibilityCents':0,'status':'denied-pending-review','liabilityConfirmed':False,'amountUnderReviewCents':30000,'deductibleAppliedCents':0})
assert len(cards)+len(eobs)==100
for c in cards:
    v=c['card']; assert v['previousBalanceCents']+v['purchasesCents']+v['interestFeesCents']-v['paymentsCreditsCents']==v['newBalanceCents']
    assert sum(t['amountCents'] for t in v['transactions'])==v['purchasesCents']
for r in eobs:
    for v in r['claims']:
        if v['liabilityConfirmed']:
            assert v['billedCents']==v['contractualAdjustmentCents']+v['allowedCents']
            assert v['allowedCents']==v['planPaidCents']+v['patientResponsibilityCents']
dump('customers_100.json',{'seed':'SPATIAL-STUDIO-DEMO-2026-11','allSynthetic':True,'recordCount':100,'creditCard':cards,'healthcareEob':eobs})

# Full 20-rule exemplar AST, with explicit priority/exclusivity/policies.
def cond(path,op,value):return {'op':op,'path':path,'value':value}
def rule(id,doc,mode,prio,when,action,group=None):
    x={'id':id,'scope':doc,'mode':mode,'priority':prio,'when':when,'then':action,'version':1}
    if group:x['exclusiveGroup']=group
    return x
def variant(name):return {'op':'selectVariant','targetNodeId':'payment-guidance' if name.startswith('payment-') else 'eob-claim-message','variantId':name}
def add(name):return {'op':'showSection','targetNodeId':name}
def require(nodes):return {'op':'requireNodes','nodeIds':nodes}
C='credit-statement';E='eob'
ra=[
rule('R01',C,'exclusive',100,cond('card.paymentStatus','eq','current'),variant('payment-standard'),'payment-guidance'),
rule('R02',C,'exclusive',200,cond('card.missedPayments','eq',1),variant('payment-reminder'),'payment-guidance'),
rule('R03',C,'exclusive',300,{'op':'and','args':[cond('card.missedPayments','gte',2),cond('card.assistanceRequested','eq',False)]},variant('payment-support-offer'),'payment-guidance'),
rule('R04',C,'exclusive',400,cond('card.assistanceRequested','eq',True),variant('payment-assistance-requested'),'payment-guidance'),
rule('R05',C,'exclusive',500,cond('card.arrangementStatus','eq','approved'),variant('payment-arrangement-active'),'payment-guidance'),
rule('R06',C,'additive',30,cond('card.tier','eq','premium'),add('relationship-manager')),
rule('R07',C,'additive',30,cond('customer.locale','eq','es-US'),{'op':'setApprovedLocale','locale':'es-US','errorIfMissingMandatoryTranslation':True}),
rule('R08',C,'additive',30,cond('card.channelPreference','eq','digital'),{'op':'setPresentationHint','hint':'interactive-action-with-print-fallback'}),
rule('R09',C,'additive',30,cond('card.channelPreference','eq','print'),{'op':'setPresentationHint','hint':'print-friendly-guidance'}),
rule('R10',C,'additive',30,cond('card.transactions.count','gt',25),{'op':'setPresentationHint','hint':'repeating-table-headings-and-continuation'}),
rule('R11',C,'additive',30,cond('card.rewardsBalance','gt',0),add('rewards-summary')),
rule('R12',C,'obligation',1000,cond('documentType','eq','credit-statement'),require(['billing-summary','payment-due','sample-disclosure-set'])),
rule('R13',E,'exclusive',300,cond('claim.status','eq','processed-covered'),variant('eob-covered'),'eob-claim-message'),
rule('R14',E,'exclusive',400,cond('claim.status','eq','denied-pending-review'),variant('eob-review-needed'),'eob-claim-message'),
rule('R15',E,'exclusive',500,cond('claim.status','eq','appeal-filed'),variant('eob-appeal-status'),'eob-claim-message'),
rule('R16',E,'additive',30,cond('claim.network','eq','out-of-network'),add('network-explanation')),
rule('R17',E,'additive',30,cond('claim.deductibleAppliedCents','gt',0),add('deductible-explanation')),
rule('R18',E,'additive',30,{'op':'and','args':[cond('claim.patientResponsibilityCents','gt',0),cond('claim.liabilityConfirmed','eq',True)]},add('member-responsibility-summary')),
rule('R19',E,'additive',30,cond('claims.count','gt',1),add('multi-claim-index')),
rule('R20',E,'obligation',1000,cond('documentType','eq','eob'),require(['not-a-bill-banner','claim-identifiers','totals-and-terms']))
]
assert len(ra)==20
dump('rules_20.json',ra)

journeys={
 'card':{'snapshotPolicy':'issued-is-immutable','events':[
  {'eventId':'card-day1','effectiveAt':'2026-11-01T09:00:00-05:00','eventType':'statement.issued','effects':[],'emits':'immutable-issued-snapshot'},
  {'eventId':'card-day30','effectiveAt':'2026-12-01T09:00:00-05:00','eventType':'payment.missed','effects':[{'op':'set','path':'card.missedPayments','value':1},{'op':'set','path':'card.paymentStatus','value':'overdue'}],'emits':'new-communication-preview'},
  {'eventId':'card-day45','effectiveAt':'2026-12-16T09:00:00-05:00','eventType':'assistance.requested','effects':[{'op':'set','path':'card.assistanceRequested','value':True}],'emits':'new-communication-preview'},
  {'eventId':'card-day60','effectiveAt':'2026-12-31T09:00:00-05:00','eventType':'arrangement.approved','effects':[{'op':'set','path':'card.arrangementStatus','value':'approved'}],'emits':'new-communication-preview'}
 ]},
 'eob':{'snapshotPolicy':'issued-is-immutable','events':[
  {'eventId':'eob-received','eventType':'claim.received','effects':[{'op':'set','path':'claim.status','value':'received'}]},
  {'eventId':'eob-adjudicated','eventType':'claim.adjudicated','effects':[{'op':'set','path':'claim.status','value':'processed-covered'}]},
  {'eventId':'eob-review','eventType':'claim.review.requested','effects':[{'op':'set','path':'claim.status','value':'denied-pending-review'},{'op':'set','path':'claim.liabilityConfirmed','value':False}]},
  {'eventId':'eob-appeal','eventType':'appeal.filed','effects':[{'op':'set','path':'claim.status','value':'appeal-filed'}]}
 ]}
}
dump('journeys.json',journeys)

content_parts=[]
content_templates=[
 ('payment-standard','Payment instructions','Your payment is due on {{card.dueDate}}.'),
 ('payment-reminder','Payment reminder','We noticed your scheduled payment has not yet arrived.'),
 ('payment-support-offer','Payment support','If making a payment is difficult, review assistance options.'),
 ('payment-assistance-requested','Assistance requested','We have received your request for payment assistance.'),
 ('payment-arrangement-active','Arrangement active','Your approved payment arrangement is active.'),
 ('relationship-manager','Relationship team','Contact your assigned relationship specialist.'),
 ('rewards-summary','Your rewards','Your current rewards points: {{card.rewardsBalance}}.'),
 ('billing-summary','Account summary','New balance: {{card.newBalanceCents}}.'),
 ('payment-due','Payment due','Minimum payment: {{card.minimumDueCents}}.'),
 ('sample-disclosure-set','Demonstration disclosures','Illustrative disclosure wording; not a compliant credit statement.'),
 ('merchant-table-heading','Recent transactions','Transaction date, merchant, amount.'),
 ('account-details','Account details','Account: {{card.maskedAccount}}.'),
 ('payment-online','Pay online','Use your issuer account portal to review options.'),
 ('paper-qr-fallback','Paper fallback','Use the printed website address to get assistance.'),
 ('welcome-cardholder','Welcome','We are pleased to welcome you as a cardholder.'),
 ('high-volume-help','Transaction guide','See the continuation pages for the complete transaction list.'),
 ('language-warning','Translation notice','Required approved translation is missing.'),
 ('credit-adjustment-note','Credits explained','Credits and adjustments reduce your balance.'),
 ('eob-covered','Covered services','The plan has processed the listed service.'),
 ('eob-review-needed','Claim under review','This claim requires review; do not treat reviewed charges as a bill.'),
 ('eob-appeal-status','Appeal update','Your appeal is being reviewed.'),
 ('network-explanation','Network status','The claim was submitted as out-of-network.'),
 ('deductible-explanation','Deductible','Some allowed charges apply to your deductible.'),
 ('member-responsibility-summary','Member responsibility','Estimated member responsibility: {{claim.patientResponsibilityCents}}.'),
 ('multi-claim-index','Multiple claims','This explanation includes more than one claim.'),
 ('not-a-bill-banner','This is not a bill','THIS IS NOT A BILL.'),
 ('claim-identifiers','Claim reference','Claim identifier: {{claim.claimId}}.'),
 ('totals-and-terms','Claim totals','Billed, allowed, plan paid and patient responsibility are shown.'),
 ('claim-glossary','Terms explained','View explanations for allowed amount, deductible and adjustment.'),
 ('eob-processing','Processing your claim','Your health plan has received this claim and is processing it.')
]
for id,title,body in content_templates:
    content_parts.append({'id':id,'version':1,'title':title,'approvedLocales':{'en-US':body},'syntheticDemoOnly':True,'type':'disclosure' if id in ('not-a-bill-banner','sample-disclosure-set') else 'text'})
assert len(content_parts)==30
dump('content_parts_30.json',content_parts)

# UI source-model seed with exact 15 component type definitions and example placed nodes.
components=[('container','Container / Section'),('rich-text','Rich Text'),('image','Image / Logo'),('shape','Shape / Divider'),('header-footer','Header / Footer'),('bound-field','Bound Field'),('repeating-table','Repeating Table'),('summary-metric','Summary / Metric'),('chart','Chart'),('conditional-region','Conditional Region'),('variant-set','Variant Set'),('disclosure','Disclosure'),('action-link','Action / Link'),('qr-code','QR Code'),('expandable-explanation','Expandable Explanation')]
dump('component_catalog_15.json',[{'type':x,'label':y,'supportsLayoutProfiles':['paged-pdf','paged-afp-sim','html-responsive'],'supportsDataBinding':x in ('bound-field','repeating-table','summary-metric','chart','conditional-region','variant-set','rich-text')} for x,y in components])
projects=[
{'schemaVersion':'1.0.0','projectId':'aster-card-demo','title':'Aster Card – credit-card statement','documentType':'credit-statement','modelVersion':1,
 'rootNodeId':'doc-root','nodes':[{'id':'doc-root','type':'container','children':['billing-summary','payment-due','payment-guidance','transaction-table','sample-disclosure-set']},
 {'id':'billing-summary','type':'summary-metric','binding':'card.newBalanceCents','formatter':'usd-cents'},
 {'id':'payment-due','type':'summary-metric','binding':'card.minimumDueCents','formatter':'usd-cents'},
 {'id':'payment-guidance','type':'variant-set','policy':'exclusive','fallbackVariantId':'payment-standard','variantIds':['payment-standard','payment-reminder','payment-support-offer','payment-assistance-requested','payment-arrangement-active']},
 {'id':'transaction-table','type':'repeating-table','binding':'card.transactions','flowContinuation':True},
 {'id':'sample-disclosure-set','type':'disclosure','required':True,'contentPartId':'sample-disclosure-set'}],
 'presentationProfiles':[{'id':'paged-pdf','kind':'paged','paper':'US-Letter','pageMarginsMm':[14,14,14,14]},
 {'id':'paged-afp-sim','kind':'afp-simulation','paper':'US-Letter','duplex':False,'simulationOnly':True},
 {'id':'html-responsive','kind':'responsive','breakpointsPx':[600,960]}]},
{'schemaVersion':'1.0.0','projectId':'harborcare-demo','title':'HarborCare – explanation of benefits','documentType':'eob','modelVersion':1,
 'rootNodeId':'doc-root','nodes':[{'id':'doc-root','type':'container','children':['not-a-bill-banner','claim-identifiers','eob-claim-message','claim-table','totals-and-terms']},
 {'id':'not-a-bill-banner','type':'disclosure','required':True,'contentPartId':'not-a-bill-banner'},
 {'id':'claim-identifiers','type':'bound-field','binding':'claim.claimId'},
 {'id':'eob-claim-message','type':'variant-set','policy':'exclusive','fallbackVariantId':'eob-processing','variantIds':['eob-processing','eob-covered','eob-review-needed','eob-appeal-status']},
 {'id':'claim-table','type':'repeating-table','binding':'claims'},
 {'id':'totals-and-terms','type':'disclosure','required':True,'contentPartId':'totals-and-terms'}],
 'presentationProfiles':[{'id':'paged-pdf','kind':'paged','paper':'US-Letter','pageMarginsMm':[14,14,14,14]},
 {'id':'paged-afp-sim','kind':'afp-simulation','paper':'US-Letter','duplex':False,'simulationOnly':True},
 {'id':'html-responsive','kind':'responsive','breakpointsPx':[600,960]}]}
]
dump('projects.json',projects)

# Strong manifest for the contents, data disclaimers, and known intentional simplifications.
manifest={'bundle':'InfoSlips Spatial Studio POC example fixtures','version':'1.0.0','syntheticOnly':True,'bankCustomerCount':70,'eobCustomerCount':30,
 'personaCount':12,'componentTypeCount':15,'ruleCount':20,'contentPartCount':30,'currencyEncoding':'integer cents','disclaimer':'Demonstration data; not a certified financial statement, healthcare bill, compliance library or production AFP generator.',
 'knownLimitations':['EOB denial/appeal is a modeled illustration, not adjudication','minimum payments/APR disclosures are illustrative','all output rendering remains to be implemented']}
dump('manifest.json',manifest)
(root/'README.txt').write_text('InfoSlips Spatial Studio seed fixture bundle, v1.0.\nAll data is synthetic. Load manifest.json first.\n100 records split 70 card / 30 EOB; 12 persona presets; 20 versioned rules; 30 content parts; 15 components; 2 project seeds and journeys.\nThese are specification/seed assets. The app and renderers have not been built.\n',encoding='utf8')
print('Wrote',len(list(root.glob('*'))),'fixture files; card',len(cards),'eob',len(eobs),'rules',len(ra),'content',len(content_parts))
