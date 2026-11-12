"""Pure standard-library structural pack contract checks; no application required."""
import json
import pathlib
import unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
def r(path): return json.loads((ROOT/path).read_text(encoding='utf-8'))

class PackContractTests(unittest.TestCase):
    def test_fixture_counts_and_ids(self):
        m=r('fixtures/manifest.json'); customers=r('fixtures/customers_100.json')
        self.assertEqual(len(customers['creditCard']),70)
        self.assertEqual(len(customers['healthcareEob']),30)
        for f,n in [('personas.json',12),('rules_20.json',20),('content_parts_30.json',30),('component_catalog_15.json',15),('projects.json',2)]:
            with self.subTest(file=f): self.assertEqual(len(r('fixtures/'+f)),n)
        ids=[x['recordId'] for x in customers['creditCard']+customers['healthcareEob']]
        self.assertEqual(len(ids),len(set(ids)))
        self.assertTrue(all(x['customer']['synthetic'] for x in customers['creditCard']+customers['healthcareEob']))

    def test_all_screen_routes_and_test_ids(self):
        d=r('contracts/SCREEN_CONTRACT.json'); s=d['screens'];self.assertEqual(len(s),12)
        self.assertEqual([x['id'] for x in s],[f'S{i:02}' for i in range(1,13)])
        self.assertEqual(len({x['route'] for x in s}),12)
        self.assertTrue(all(x['requiredTestIds'] for x in s))

    def test_all_36_acceptances_are_unique(self):
        a=r('contracts/ACCEPTANCE_MATRIX.json')['tests']
        self.assertEqual([t['id'] for t in a],[f'AT-{i:02}' for i in range(1,37)])
        self.assertEqual(set(x['status'] for x in a),{'NOT_RUN'})
        self.assertTrue(all(t['expected'] and t['steps'] for t in a))
        statuses=r('reports/ACCEPTANCE_STATUS.json')['tests']
        self.assertEqual(set(statuses),set(t['id'] for t in a))

    def test_project_refs_and_component_catalog(self):
        projects=r('fixtures/projects.json'); allowed={c['type'] for c in r('fixtures/component_catalog_15.json')}
        parts={c['id'] for c in r('fixtures/content_parts_30.json')}
        self.assertEqual(len(allowed),15)
        for p in projects:
            with self.subTest(project=p['projectId']):
                ids=[n['id'] for n in p['nodes']]; self.assertEqual(len(ids),len(set(ids)))
                self.assertIn(p['rootNodeId'],ids)
                for n in p['nodes']:
                    self.assertIn(n['type'],allowed)
                    for child in n.get('children',[]): self.assertIn(child,ids)
                    if 'contentPartId' in n: self.assertIn(n['contentPartId'],parts)
                    for v in n.get('variantIds',[]):self.assertIn(v,parts)
                self.assertEqual({x['id'] for x in p['presentationProfiles']},{'paged-pdf','paged-afp-sim','html-responsive'})

    def test_rule_ast_and_target_integrity(self):
        rules=r('fixtures/rules_20.json')
        self.assertEqual(len({x['id'] for x in rules}),20)
        parts={c['id'] for c in r('fixtures/content_parts_30.json')}
        project_by_scope={p['documentType']:p for p in r('fixtures/projects.json')}
        def pred(x):
            op=x['op']
            if op in ('and','or'):
                self.assertGreater(len(x['args']),0)
                for a in x['args']:pred(a)
            elif op=='not':pred(x['arg'])
            else:
                self.assertIn(op,('eq','ne','gt','gte','lt','lte','in'))
                self.assertIn('path',x)
                self.assertIn('value',x)
        for rule in rules:
            pred(rule['when'])
            nodes={x['id'] for x in project_by_scope[rule['scope']]['nodes']}
            if rule['mode']=='exclusive':
                self.assertIn(rule['exclusiveGroup'],nodes)
                self.assertIn(rule['then']['variantId'],parts)
            if rule['then']['op']=='showSection':
                self.assertIn(rule['then']['targetNodeId'],parts)
            if rule['mode']=='obligation':
                self.assertTrue(set(rule['then']['nodeIds']).issubset(nodes))

    def test_synthetic_financial_reconciliation(self):
        customers=r('fixtures/customers_100.json')
        for record in customers['creditCard']:
            c=record['card']
            # All seed records must reconcile (special scenarios may intentionally break it)
            self.assertEqual(c['newBalanceCents'],c['previousBalanceCents']+c['purchasesCents']-c['paymentsCreditsCents']+c['interestFeesCents'])
        for record in customers['healthcareEob']:
            for c in record['claims']:
                if c['status']=='processed-covered':
                    self.assertEqual(c['billedCents'],c['allowedCents']+c['contractualAdjustmentCents'])
                    self.assertEqual(c['allowedCents'],c['planPaidCents']+c['patientResponsibilityCents'])

if __name__=='__main__':unittest.main()
