"""Data-only independent golden contract tests; run before application exists."""
import copy
import json
import pathlib
import sys
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'oracle'))
from reference_resolver import cases_to_goldens,resolve,load,canon,digest,scenario_cases

class OracleTests(unittest.TestCase):
    def test_all_twelve_named_goldens_are_stable(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        self.assertEqual(len(frozen),12)
        self.assertEqual(cases_to_goldens(),frozen)

    def test_golden_digest_recomputes(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        for name,case in frozen.items():
            with self.subTest(name=name):
                e=dict(case['expected']); actual=e.pop('resultDigest')
                self.assertEqual(digest(e),actual)

    def test_exclusive_selection_by_priority(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        self.assertEqual(frozen['card-standard']['expected']['selectedVariants']['payment-guidance'],'payment-standard')
        self.assertEqual(frozen['card-arrangement-approved']['expected']['selectedVariants']['payment-guidance'],'payment-arrangement-active')
        self.assertIsNone(frozen['card-tie-defect']['expected']['selectedVariants']['payment-guidance'])
        self.assertIn('EXCLUSIVE_PRIORITY_TIE',{x['code'] for x in frozen['card-tie-defect']['expected']['diagnostics']})

    def test_missing_translation_is_blocking(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        ds=frozen['card-spanish-missing-mandatory-translation']['expected']['diagnostics']
        self.assertTrue(any(x['code']=='REQUIRED_TRANSLATION_MISSING' and x['severity']=='blocking' for x in ds))

    def test_eob_unconfirmed_patient_liability_blocked(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        self.assertIn('UNCONFIRMED_MEMBER_LIABILITY',{x['code'] for x in frozen['eob-unconfirmed-liability']['expected']['diagnostics']})
        self.assertTrue(frozen['eob-under-review']['expected']['documentFacts']['notABill'])

    def test_250_rows_preserve_purchase_sum(self):
        frozen=json.loads((ROOT/'fixtures/expected_scenarios.json').read_text())['cases']
        case=frozen['card-250-rows']; rows=case['overrides']['card']['transactions']
        self.assertEqual(len(rows),250)
        self.assertEqual(sum(x['amountCents'] for x in rows),50800)
        self.assertEqual(case['expected']['documentFacts']['transactionCount'],250)

    def test_reference_resolver_does_not_mutate_record(self):
        record=next(x for x in load('customers_100.json')['creditCard'] if x['recordId']=='CARD-0001')
        old=copy.deepcopy(record)
        resolve(record,overrides={'card':{'missedPayments':1,'paymentStatus':'overdue'}})
        self.assertEqual(old,record)

if __name__=='__main__': unittest.main()
