#!/usr/bin/env python3
"""Leakage-safe Lom daily persistence evaluation; 2024 dev, 2025 holdout."""
import argparse,csv,json,statistics
from datetime import date,timedelta
from pathlib import Path

def load(path):
    with open(path,encoding='utf-8',newline='') as f:
        return {date.fromisoformat(r['observedDate']):float(r['value']) for r in csv.DictReader(f) if r['value']!=''}
def evaluate(series,targets,horizon):
    errors={'all':[],'rising':[],'falling':[],'unchanged':[]}
    for target in sorted(targets):
        actual=series[target]
        origin=target-timedelta(days=horizon)
        if origin not in series: continue
        # Information set ends at origin; forecast is latest available level.
        errors['all'].append(abs(actual-series[origin]))
        previous=target-timedelta(days=1)
        if previous in series:
            direction='rising' if actual>series[previous] else 'falling' if actual<series[previous] else 'unchanged'
            errors[direction].append(abs(actual-series[origin]))
    return {k:{'n':len(v),'maeCm':round(statistics.mean(v),4) if v else None} for k,v in errors.items()}
def main():
    p=argparse.ArgumentParser();p.add_argument('--development-2024',required=True,type=Path);p.add_argument('--evaluation-2025',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    dev=load(a.development_2024); test=load(a.evaluation_2025); history={**dev,**test}
    result={'developmentYear':2024,'developmentDates':len(dev),'evaluationYear':2025,'evaluationDates':len(test),'evaluationWindow':'All dates 2025-01-01 through 2025-12-31 with the required prior observation available, including development-year observations as forecast origins for the first horizon days.','forecastAssumption':'At the start of target calendar date t, the latest published daily value is from t-horizon; actual APPD publication latency is unknown, so scores are not operational accuracy.','horizons':{str(h):evaluate(history,test,h) for h in (1,2)}}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
