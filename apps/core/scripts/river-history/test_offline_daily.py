import importlib.util,sys,unittest
from datetime import date
from pathlib import Path
BASE=Path(__file__).parent

def load(name,file):
 s=importlib.util.spec_from_file_location(name,BASE/file);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
extract=load('extract_appd_annual','extract-appd-annual.py')
backtest=load('backtest_daily_persistence','backtest-daily-persistence.py')
verify=load('verify_appd_levels','verify-appd-levels.py')
class OfflineDailyTests(unittest.TestCase):
 def test_parse_and_missing_calendar_day(self):
  rows,rejected=extract.parse_rows('01.01.2024 10 20 2.5\n03.01.2024 11 21 2.6')
  self.assertEqual(rejected,0);self.assertIn('2024-01-02',extract.validate_rows(rows,2024)['missingDates'])
 def test_duplicate_and_invalid_date_rows_rejected_by_validation(self):
  rows,_=extract.parse_rows('01.01.2024 10 20 2.5\n01.01.2024 11 21 2.6')
  self.assertEqual(extract.validate_rows(rows,2024)['duplicates'],1)
  with self.assertRaises(ValueError): extract.parse_rows('32.01.2024 10 20 2.5')
 def test_exact_horizon_alignment_and_leakage(self):
  s={date(2025,1,1):10.,date(2025,1,2):12.,date(2025,1,3):15.}
  a=backtest.evaluate(s,s,1);self.assertEqual(a['all']['n'],2);self.assertEqual(a['all']['maeCm'],2.5)
  s[date(2025,1,3)]=999.
  self.assertEqual(s[date(2025,1,2)],12.) # t+1 forecast origin unaffected by future truth
 def test_evaluation_uses_development_history_for_january_origins(self):
  history={date(2024,12,30):10.,date(2024,12,31):12.,date(2025,1,1):15.,date(2025,1,2):14.}
  targets={d:v for d,v in history.items() if d.year==2025}
  self.assertEqual(backtest.evaluate(history,targets,1)['all']['n'],2)
  self.assertEqual(backtest.evaluate(history,targets,2)['all']['n'],2)
 def test_forecast_uses_only_issue_date_or_earlier_and_station_changes(self):
  lom={date(2024,1,1):100.,date(2024,1,2):110.,date(2024,1,3):115.,date(2024,1,4):999.}
  novo={date(2024,1,1):20.,date(2024,1,2):25.,date(2024,1,3):30.}
  target=date(2024,1,4)
  self.assertEqual(backtest.forecast(lom,novo,target,1,alpha=.5),117.5)
  self.assertEqual(backtest.forecast(lom,novo,target,1,alpha=0,beta=1,lag=1),120.)
 def test_chronological_window_and_coefficient_selection(self):
  from datetime import timedelta
  d=date(2020,1,1)
  yearly={2020:{d:10.,d+timedelta(days=1):11.,d+timedelta(days=2):13.},2021:{d+timedelta(days=3):14.5}}
  training=backtest.development_window(yearly,2021)
  self.assertEqual(set(training),set(yearly[2020]))
  selection_data={**training,d+timedelta(days=3):14.5}
  self.assertEqual(backtest.choose(selection_data,{},[d+timedelta(days=3)],1)['alpha'],.5)
 def test_missing_metric_is_not_zero(self):
  row=extract.Reading(date(2024,1,1),10.,None,None)
  self.assertIsNone(row.discharge_m3s);self.assertIsNone(row.temperature_c)
 def test_pdf_input_must_be_an_existing_file(self):
  with self.assertRaisesRegex(ValueError,'PDF file does not exist'):
   extract.resolve_pdf(Path('.'))
 def test_pdf_form_feed_does_not_drop_page_break_rows(self):
  text=''.join(f'{d:02}.02.2024 {d} 1 1.0\fPage header\n' for d in (2,))
  rows=verify.pdf_levels(text)
  self.assertEqual(rows,[('2024-02-02',2.0)])
if __name__=='__main__':unittest.main()
