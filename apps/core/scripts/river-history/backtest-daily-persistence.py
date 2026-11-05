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

def select_local_alpha(history,train_targets,horizon):
    return choose(history,{},train_targets,horizon)['alpha']

def development_window(yearly_series,evaluation_year):
    years=range(min(yearly_series),evaluation_year)
    return {d:value for year in years for d,value in yearly_series[year].items()}

def expanding_year(lom,year,horizon,alpha,large_change_cm):
    targets=sorted(d for d in lom if d.year==year)
    paired=[]
    for target in targets:
      persistence=forecast(lom,{},target,horizon)
      trend=forecast(lom,{},target,horizon,alpha)
      if persistence is not None and trend is not None:
       actual=lom[target]; paired.append((target,abs(actual-persistence),abs(actual-trend)))
    def summarize(column):
      vals=sorted((row[0],row[column]) for row in paired); errors=sorted(value for _,value in vals)
      return {'n':len(vals),'maeCm':round(statistics.mean(errors),4) if errors else None,'medianAbsErrorCm':round(errors[len(errors)//2],4) if errors else None,'p90AbsErrorCm':round(errors[(9*len(errors)+9)//10-1],4) if errors else None,'maxAbsErrorCm':round(errors[-1],4) if errors else None,'largestMisses':[{'date':d.isoformat(),'errorCm':round(e,4)} for d,e in sorted(vals,key=lambda x:(-x[1],x[0]))[:3]]}
    result={'targetDates':len(targets),'pairedDates':len(paired),'persistence':summarize(1),'localTrend':summarize(2)}
    if paired:
      result['improvementPct']=round(100*(result['persistence']['maeCm']-result['localTrend']['maeCm'])/result['persistence']['maeCm'],2)
      result['pairedAbsoluteErrorDifferenceMeanCm']=round(statistics.mean(p-t for _,p,t in paired),4)
      regimes={k:[] for k in ('rising','falling','unchanged')}; seasons={k:[] for k in ('DJF','MAM','JJA','SON')}; large=[]
      for d,p,t in paired:
       prev=d-timedelta(days=1)
       if prev in lom:
        state='rising' if lom[d]>lom[prev] else 'falling' if lom[d]<lom[prev] else 'unchanged'; regimes[state].append((p,t))
       seasons[{12:'DJF',1:'DJF',2:'DJF',3:'MAM',4:'MAM',5:'MAM',6:'JJA',7:'JJA',8:'JJA',9:'SON',10:'SON',11:'SON'}[d.month]].append((p,t))
       if prev in lom and abs(lom[d]-lom[prev])>=large_change_cm: large.append((p,t))
      def pair_stats(rows):
       return {'n':len(rows),'persistenceMaeCm':round(statistics.mean(x[0] for x in rows),4) if rows else None,'localTrendMaeCm':round(statistics.mean(x[1] for x in rows),4) if rows else None}
      result['regimes']={k:pair_stats(v) for k,v in regimes.items()}; result['seasons']={k:pair_stats(v) for k,v in seasons.items()}; result['largeChangeThresholdCm']=large_change_cm; result['largeChanges']=pair_stats(large)
    return result

def percentile90(values):
    ordered=sorted(values)
    return ordered[(9*len(ordered)+9)//10-1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,default=Path('data/river-history/normalized/annual'));p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    lom={y:load(a.data_dir/f'lom-water-level-{y}.csv') for y in range(2020,2026)}
    reports={}
    for horizon in (1,2):
      years={}
      for year in range(2021,2025):
       train=development_window(lom,year)
       train_targets=sorted(train)
       selection=choose(train,{},train_targets,horizon); alpha=selection['alpha']
       deltas=[abs(train[d]-train[d-timedelta(days=1)]) for d in train if d-timedelta(days=1) in train]
       threshold=percentile90(deltas)
       combined={**train,**lom[year]}
       years[str(year)]={'selectionHistoryYears':list(range(2020,year)),'selectedAlpha':alpha,'trainingTargetDates':len(train_targets),'coefficientSelectionSamples':selection['n'],'selectionMaeCm':selection['developmentMaeCm'],'largeChangeThresholdCm':threshold,'evaluation':expanding_year(combined,year,horizon,alpha,threshold)}
      # Context only: cite the already-examined M2.2 holdout without refitting it.
      previous=json.loads(Path('data/river-history/reports/validation/upstream-forecast-2025.json').read_text())['horizons'][str(horizon)]['evaluation']
      years['2025_context']={'source':'M2.2 previously examined holdout; not an independent confirmation','persistence':previous['persistence'],'localTrend':previous['localTrend'],'selectedAlpha':0.5}
      reports[str(horizon)]=years
    result={'developmentRule':'Expanding chronological history; choose alpha from fixed grid [-0.5,0,0.5,1,1.5] by training MAE for the requested horizon. 2025 is contextual only and was previously examined.','evaluationRule':'Paired persistence/local-trend target dates; issue-date input is target minus horizon; prior-year history supplies January origins. Seasonal and regime labels describe outcomes only. Large-change threshold is 90th percentile of absolute daily Lom changes in training history.','forecastAssumption':'Daily observations are assumed available by issue date; APPD publication latency is unknown. Hindcasts are not prospective operational validation.','horizons':reports}
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
