"""Rebuild approved expected resolver outcomes; only use to audit intentional contract changes."""
import json
from pathlib import Path
from reference_resolver import cases_to_goldens
p=Path(__file__).resolve().parents[1]/'fixtures'/'expected_scenarios.json'
p.write_text(json.dumps({'oracleVersion':'1.0','warning':'Reference golden outputs from independent Python test oracle, not from a built app','cases':cases_to_goldens()},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('wrote',p)
