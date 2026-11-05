import calendar,csv,re,subprocess,json
from pathlib import Path
BASE=Path('data/river-history')
ROW=re.compile(r'(?m)^(\d{2})\.(\d{2})\.(\d{4})\s+(-?\d+)\s+\d+\s+[-\d.,]+')

def pdf_levels(text):
    return [(f'{y}-{m}-{d}',float(level)) for d,m,y,level in ROW.findall(text.replace('\f',' '))]

def main():
 report={'method':'Independent pdftotext -raw scan of printed date and H column; form-feed separators normalized as whitespace; reconcile by calendar date.','documents':[]}
 for station in ('novo-selo','lom'):
  for year in (2024,2025):
   pdf=BASE/'raw'/station/f'{station}-{year}.pdf'; text=subprocess.run(['pdftotext','-raw',str(pdf),'-'],capture_output=True,text=True,check=True).stdout
   found=pdf_levels(text)
   csvpath=BASE/'normalized/annual'/f'{station}-water-level-{year}.csv'
   got={r['observedDate']:float(r['value']) for r in csv.DictReader(csvpath.open())}
   import datetime
   expected={datetime.date(year,m,d).isoformat() for m in range(1,13) for d in range(1,calendar.monthrange(year,m)[1]+1)}
   pdfmap=dict(found)
   missing=sorted(expected-set(pdfmap)); unexpected=sorted(set(pdfmap)-expected); csv_missing=sorted(expected-set(got)); discrepancies=[{'date':d,'pdf':pdfmap[d],'csv':got.get(d)} for d in sorted(set(pdfmap)|set(got)) if pdfmap.get(d)!=got.get(d)]
   report['documents'].append({'station':station,'year':year,'pdf':str(pdf),'pdfRows':len(found),'csvRows':len(got),'matchedDates':len(set(pdfmap)&set(got)),'missingPdfDates':missing,'missingCsvDates':csv_missing,'duplicatePdfDates':len(found)-len(pdfmap),'unexpectedPdfDates':unexpected,'levelDiscrepancies':discrepancies,'negativeLevels':{d:v for d,v in pdfmap.items() if v<0}})
 print(json.dumps(report,indent=2))

if __name__=='__main__': main()
