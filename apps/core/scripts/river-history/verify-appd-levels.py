import calendar,csv,re,subprocess,json
import argparse
from pathlib import Path
BASE=Path('data/river-history')
ROW=re.compile(r'(?m)^(\d{2})\.(\d{2})\.(\d{4})\s+(-?\d+)\s+\d+\s+[-\d.,]+')

def pdf_levels(text):
    return [(f'{y}-{m}-{d}',float(level)) for d,m,y,level in ROW.findall(text.replace('\f',' '))]

def main():
 parser=argparse.ArgumentParser(); parser.add_argument('--years',nargs='+',type=int,default=[2024,2025]); args=parser.parse_args()
 report={'method':'Independent pdftotext -raw scan of printed date and H column; form-feed separators normalized as whitespace; reconcile by calendar date.','documents':[]}
 for station in ('novo-selo','lom'):
  for year in args.years:
   pdf=BASE/'raw'/station/f'{station}-{year}.pdf'; text=subprocess.run(['pdftotext','-raw',str(pdf),'-'],capture_output=True,text=True,check=True).stdout
   found=pdf_levels(text)
   csvpath=BASE/'normalized/annual'/f'{station}-water-level-{year}.csv'
   csv_rows=list(csv.DictReader(csvpath.open())); got={r['observedDate']:float(r['value']) for r in csv_rows}
   import datetime
   expected={datetime.date(year,m,d).isoformat() for m in range(1,13) for d in range(1,calendar.monthrange(year,m)[1]+1)}
   pdfmap=dict(found)
   missing=sorted(expected-set(pdfmap)); unexpected=sorted(set(pdfmap)-expected); csv_missing=sorted(expected-set(got)); discrepancies=[{'date':d,'pdf':pdfmap[d],'csv':got.get(d)} for d in sorted(set(pdfmap)|set(got)) if pdfmap.get(d)!=got.get(d)]
   metadata={'station': 'Novo Selo' if station=='novo-selo' else 'Lom','stationCode':station,'unit':'cm','sourceUrl':'https://www.appd-bg.org/pages?id=opendata','documentYear':str(year),'riverKm':'833.6' if station=='novo-selo' else '743.3','zeroElevationM':'-26.75' if station=='novo-selo' else '22.65','datum':'Baltic Sea–Kronstadt'}
   metadata_errors=[r['observedDate'] for r in csv_rows if any(r.get(k)!=v for k,v in metadata.items())]
   date_tokens=len(re.findall(r'\b\d{2}\.\d{2}\.\d{4}\b',text))
   report['documents'].append({'station':station,'year':year,'pdf':str(pdf),'pdfPages':text.count('\f'),'pdfDateTokens':date_tokens,'unparsedDateTokens':date_tokens-len(found),'pdfRows':len(found),'csvRows':len(got),'matchedDates':len(set(pdfmap)&set(got)),'missingPdfDates':missing,'missingCsvDates':csv_missing,'duplicatePdfDates':len(found)-len(pdfmap),'unexpectedPdfDates':unexpected,'levelDiscrepancies':discrepancies,'metadataErrors':metadata_errors,'negativeLevels':{d:v for d,v in pdfmap.items() if v<0}})
 print(json.dumps(report,indent=2))

if __name__=='__main__': main()
