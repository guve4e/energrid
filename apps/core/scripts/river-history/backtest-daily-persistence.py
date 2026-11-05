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

def forecast(lom,novo,target,horizon,alpha=0.,beta=0.,lag=1):
    issue=target-timedelta(days=horizon)
    required=[issue,issue-timedelta(days=1)]
    if any(d not in lom for d in required): return None
    prediction=lom[issue]+alpha*(lom[issue]-lom[required[1]])
    upstream_day=issue-timedelta(days=lag)
    if beta:
        if upstream_day not in novo or upstream_day-timedelta(days=1) not in novo: return None
        prediction+=beta*(novo[upstream_day]-novo[upstream_day-timedelta(days=1)])
    return prediction

def choose(lom,novo,targets,horizon,upstream=False):
    best=None
    alphas=(0.,-.5,.5,1.,1.5)
    betas=(-1.,-.5,.5,1.) if upstream else (0.,)
    lags=range(1,8) if upstream else (1,)
    for alpha in alphas:
      for beta in betas:
       for lag in lags:
        errs=[]
        for target in targets:
         pred=forecast(lom,novo,target,horizon,alpha,beta,lag)
         if pred is not None and target in lom: errs.append(abs(lom[target]-pred))
        score=statistics.mean(errs) if errs else float('inf')
        candidate=(score,alpha,beta,lag,len(errs))
        if best is None or candidate<best: best=candidate
    return {'developmentMaeCm':round(best[0],4),'alpha':best[1],'beta':best[2],'upstreamLagDays':best[3] if upstream else None,'n':best[4]}

def compare(lom_dev,novo_dev,lom_all,novo_all,targets,horizon,choices):
    errors={name:[] for name in ('persistence','localTrend','upstreamInformed')}
    for target in targets:
      if target not in lom_all: continue
      forecasts={
       'persistence':forecast(lom_all,novo_all,target,horizon),
       'localTrend':forecast(lom_all,novo_all,target,horizon,choices['localTrend']['alpha']),
       'upstreamInformed':forecast(lom_all,novo_all,target,horizon,choices['upstreamInformed']['alpha'],choices['upstreamInformed']['beta'],choices['upstreamInformed']['upstreamLagDays'])}
      if any(v is None for v in forecasts.values()): continue
      for name,pred in forecasts.items(): errors[name].append((target,abs(lom_all[target]-pred)))
    result={}
    for name,values in errors.items():
      ranked=sorted(values,key=lambda item:item[1]); magnitudes=[e for _,e in ranked]
      result[name]={'n':len(values),'maeCm':round(statistics.mean(magnitudes),4),'medianAbsErrorCm':round(magnitudes[len(magnitudes)//2],4),'p90AbsErrorCm':round(magnitudes[(9*len(magnitudes)+9)//10-1],4),'maxAbsErrorCm':round(magnitudes[-1],4),'largestMisses':[{'date':d.isoformat(),'errorCm':round(e,4)} for d,e in sorted(values,key=lambda item:(-item[1],item[0]))[:5]],'rising':_direction(lom_all,values,'rising'),'falling':_direction(lom_all,values,'falling'),'unchanged':_direction(lom_all,values,'unchanged')}
    return result

def _direction(series,errors,direction):
    selected=[]
    for day,error in errors:
      prev=day-timedelta(days=1)
      if prev not in series: continue
      state='rising' if series[day]>series[prev] else 'falling' if series[day]<series[prev] else 'unchanged'
      if state==direction:selected.append(error)
    return {'n':len(selected),'maeCm':round(statistics.mean(selected),4) if selected else None}
def main():
    p=argparse.ArgumentParser();p.add_argument('--development-2024',required=True,type=Path);p.add_argument('--evaluation-2025',required=True,type=Path);p.add_argument('--novo-selo-2024',required=True,type=Path);p.add_argument('--novo-selo-2025',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    dev=load(a.development_2024); test=load(a.evaluation_2025); history={**dev,**test}; ndev=load(a.novo_selo_2024); ntest=load(a.novo_selo_2025); nhistory={**ndev,**ntest}
    targets=sorted(d for d in test if d.year==2025)
    horizons={}
    for h in (1,2):
      local=choose(dev,ndev,sorted(d for d in dev if d.year==2024),h)
      upstream=choose(dev,ndev,sorted(d for d in dev if d.year==2024),h,True)
      horizons[str(h)]={'developmentSelection':{'localTrend':local,'upstreamInformed':upstream},'evaluation':compare(dev,ndev,history,nhistory,targets,h,{'localTrend':local,'upstreamInformed':upstream})}
    result={'developmentYear':2024,'evaluationYear':2025,'evaluationDates':len(targets),'pairedComparison':'All models use the intersection of target dates with complete values required by all three predictors.','candidateSet':{'localAlpha':[-0.5,0,0.5,1,1.5],'upstreamLagDays':[1,2,3,4,5,6,7],'upstreamBeta':[-1,-0.5,0.5,1]},'forecastAssumption':'Forecast issue date is target minus horizon. Inputs are observations no later than issue date; APPD publication latency is unknown. This is an offline daily hindcast, not operational accuracy.','horizons':horizons}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
