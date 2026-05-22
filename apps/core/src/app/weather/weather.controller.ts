import { Controller, Get, Header } from '@nestjs/common';
import { WeatherService } from './weather.service';

@Controller('weather')
export class WeatherController {
  constructor(private readonly weatherService: WeatherService) {}

  @Get('dashboard')
  async getDashboard() {
    return this.weatherService.getDashboard();
  }

  @Get('monitor')
  @Header('Content-Type', 'text/html')
  getMonitorPage() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Energrid Weather Monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:radial-gradient(circle at top left,rgba(51,96,216,.22),transparent 32%),#06101f;
  color:#f8fafc;
  font-family:Inter,Arial,sans-serif;
}
main{min-height:100vh;padding:18px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;color:#cbd5e1}
.brand{font-weight:900;font-size:22px;letter-spacing:.04em}
.brand span{color:#60a5fa}
.layout{display:grid;grid-template-columns:1.05fr 2fr;gap:14px}
.hero{
  display:grid;grid-template-columns:1.4fr 1fr;gap:20px;
  padding:22px 28px;border-radius:24px;
  background:linear-gradient(135deg,rgba(18,48,95,.96),rgba(15,23,42,.96));
  border:1px solid rgba(148,163,184,.18);
  box-shadow:0 18px 70px rgba(0,0,0,.35);
  margin-bottom:14px;
}
.hero.high{background:linear-gradient(135deg,rgba(127,29,29,.95),rgba(15,23,42,.98))}
.hero.medium{background:linear-gradient(135deg,rgba(146,64,14,.95),rgba(15,23,42,.98))}
.eyebrow,.label{color:#60a5fa;text-transform:uppercase;letter-spacing:.14em;font-size:13px;font-weight:900;margin-bottom:10px}
h1{margin:0;font-size:64px;line-height:.9}
.summary{margin-top:10px;font-size:22px;color:#dbeafe}
.heroStats{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mini,.card{
  background:rgba(15,23,42,.92);
  border:1px solid rgba(148,163,184,.18);
  border-radius:24px;
  box-shadow:0 16px 50px rgba(0,0,0,.25);
}
.mini{padding:16px}
.mini strong{display:block;font-size:28px}
.card{padding:20px}
.currentBox{display:flex;align-items:center;gap:22px}
.icon{font-size:76px;filter:drop-shadow(0 10px 20px rgba(0,0,0,.35))}
.temp{font-size:82px;font-weight:950;line-height:1}
.condition{font-size:26px;font-weight:850;margin-top:8px}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}
.metric{padding:14px;border-radius:16px;background:rgba(30,41,59,.72)}
.metric small{display:block;color:#94a3b8;font-weight:800;text-transform:uppercase}
.metric strong{font-size:24px}
.ok{color:#22c55e;font-size:26px;font-weight:900}
.risk{display:inline-block;margin:6px;padding:10px 14px;background:#991b1b;border-radius:999px;font-weight:900}
.timelineCard{grid-column:1/3}
.hours{
  position:relative;
  display:grid;
  grid-template-columns:repeat(12,1fr);
  gap:0;
  padding-top:26px;
  overflow-x:auto;
}
.hours::before{
  content:"";
  position:absolute;
  left:36px;right:36px;top:58px;height:3px;
  background:linear-gradient(90deg,#2563eb,#60a5fa,#22c55e);
  border-radius:999px;opacity:.75;
}
.hour{position:relative;min-width:86px;padding:46px 8px 10px;text-align:center}
.hour::before{
  content:"";
  position:absolute;top:25px;left:50%;
  width:13px;height:13px;transform:translateX(-50%);
  background:#60a5fa;border:3px solid #0f172a;border-radius:999px;
  box-shadow:0 0 0 3px rgba(96,165,250,.25);
}
.hour.danger::before{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.25)}
.hour.rainy::before{background:#38bdf8}
.hour .time{color:#cbd5e1;font-size:13px;font-weight:800}
.hour .hicon{font-size:28px;margin:8px 0}
.hour .htemp{font-size:22px;font-weight:900}
.hour .rain{color:#60a5fa;font-weight:800;margin-top:5px}
.hour .wind{color:#cbd5e1;font-size:12px;margin-top:4px}
.radarCard{grid-column:1/3;padding:0;overflow:hidden}
.radarHeader{padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
#map{height:390px;width:100%;background:#020617}
.danube{
  display:grid;
  grid-template-columns:1fr 1fr 1fr;
  gap:12px;
}
.riverValue{font-size:34px;font-weight:950}
.up{color:#22c55e}
.down{color:#38bdf8}
.muted{color:#94a3b8}
@media(max-width:1000px){
  .layout,.hero{grid-template-columns:1fr}
  .timelineCard,.radarCard{grid-column:auto}
  .hours{grid-template-columns:repeat(4,1fr)}
  .danube{grid-template-columns:1fr}
  h1{font-size:48px}
}
</style>
</head>
<body>
<main>
  <div class="top">
    <div class="brand"><span>ENERGRID</span> WEATHER MONITOR</div>
    <div id="updated" class="muted">Loading...</div>
  </div>

  <section id="hero" class="hero">
    <div>
      <div class="eyebrow">House weather risk</div>
      <h1 id="riskTitle">Loading...</h1>
      <div id="summary" class="summary"></div>
      <div id="meta" class="muted"></div>
    </div>
    <div class="heroStats">
      <div class="mini"><span class="muted">Alerts</span><strong id="alertCount">0</strong></div>
      <div class="mini"><span class="muted">Risks</span><strong id="riskCount">0</strong></div>
      <div class="mini"><span class="muted">Provider</span><strong id="provider">--</strong></div>
      <div class="mini"><span class="muted">Refresh</span><strong>5 min</strong></div>
    </div>
  </section>

  <section class="layout">
    <article class="card">
      <div class="label">Current conditions</div>
      <div class="currentBox">
        <div id="weatherIcon" class="icon">⛅</div>
        <div>
          <div id="temp" class="temp">--°</div>
          <div id="condition" class="condition">--</div>
        </div>
      </div>
      <div class="metrics">
        <div class="metric"><small>Wind</small><strong id="wind">--</strong></div>
        <div class="metric"><small>Gusts</small><strong id="gust">--</strong></div>
        <div class="metric"><small>Rain now</small><strong id="rainNow">--</strong></div>
        <div class="metric"><small>Code</small><strong id="code">--</strong></div>
      </div>
    </article>

    <article class="card">
      <div class="label">Risks overview</div>
      <div id="risks"></div>
    </article>

    <article class="card timelineCard">
      <div class="label">Next 12 hours timeline</div>
      <div id="hours" class="hours"></div>
    </article>

    <article class="card">
      <div class="label">Danube river — Vidin</div>
      <div class="danube">
        <div class="metric">
          <small>Level</small>
          <div id="riverLevel" class="riverValue">-- cm</div>
        </div>
        <div class="metric">
          <small>Trend</small>
          <div id="riverTrend" class="riverValue down">--</div>
        </div>
        <div class="metric">
          <small>Water temp</small>
          <div id="riverTemp" class="riverValue">--°</div>
        </div>
      </div>
     <p class="muted">Source: APPD / ИАППД river station data.</p>
    </article>

    <article class="card">
      <div class="label">House actions</div>
      <div id="actions" class="muted">No action required.</div>
    </article>

    <article class="card radarCard">
      <div class="radarHeader">
        <div class="label">Live radar map</div>
        <div class="muted">RainViewer radar overlay</div>
      </div>
      <div id="map"></div>
    </article>
  </section>
</main>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
let map;
let radarLayer;

function iconFor(code){
  if([95,96,99].includes(code))return'⛈️';
  if([61,63,65,80,81,82].includes(code))return'🌧️';
  if([71,73,75].includes(code))return'🌨️';
  if([45,48].includes(code))return'🌫️';
  if([2,3].includes(code))return'☁️';
  if([0,1].includes(code))return'☀️';
  return'⛅';
}

function initMap(){
  map=L.map('map',{zoomControl:true,minZoom:5,maxZoom:12}).setView([43.9916,22.8728],7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    minZoom:5,maxZoom:19,attribution:''
  }).addTo(map);
  L.marker([43.9916,22.8728]).addTo(map).bindPopup('Vidin / Danube');
}

let radarFrames = [];
let radarIndex = 0;
let radarTimer = null;

async function loadRadar(){
  try{
    const res=await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data=await res.json();

    radarFrames=[
      ...(data.radar?.nowcast||[])
    ];

    if(!radarFrames.length){
      radarFrames=[...(data.radar?.past||[])].slice(-1);
    }

    if(!radarFrames.length||!map)return;

    if(radarTimer)clearInterval(radarTimer);

    function showFrame(index){
      const frame=radarFrames[index];
      if(!frame)return;

      if(radarLayer)map.removeLayer(radarLayer);

      radarLayer=L.tileLayer(data.host+frame.path+'/256/{z}/{x}/{y}/2/1_1.png',{
        opacity:.72,
        zIndex:10,
        maxZoom:10,
        maxNativeZoom:10,
        noWrap:true
      }).addTo(map);

      const time=new Date(frame.time*1000).toLocaleTimeString([],{
        hour:'2-digit',
        minute:'2-digit'
      });

      document.querySelector('.radarHeader .muted').textContent =
        'RainViewer nowcast · frame ' + (index+1) + '/' + radarFrames.length + ' · ' + time;
    }

    showFrame(radarIndex);

    radarTimer=setInterval(()=>{
      radarIndex=(radarIndex+1)%radarFrames.length;
      showFrame(radarIndex);
    },900);

  }catch(e){
    console.warn('Radar failed',e);
  }
}

function renderDanube(river){
  if(!river)return;

  document.getElementById('riverLevel').textContent =
    river.levelCm == null ? '-- cm' : river.levelCm + ' cm';

  document.getElementById('riverTrend').textContent =
    river.trend + ' ' + (river.difference24hCm == null ? '' : '(' + river.difference24hCm + ' cm / 24h)');

  document.getElementById('riverTrend').className =
    'riverValue ' + (river.trend === 'rising' ? 'up' : river.trend === 'falling' ? 'down' : '');

  document.getElementById('riverTemp').textContent =
    river.waterTempC == null ? '--°' : river.waterTempC + '°';
}

async function loadWeather(){
  const res=await fetch('/core/weather/dashboard');
  const data=await res.json();
  renderDanube(data.river);
  const level=data.riskReport?.level||'low';
  document.getElementById('hero').className='hero '+level;
  document.getElementById('riskTitle').textContent=level==='high'?'WARNING':level==='medium'?'ELEVATED RISK':'NORMAL';

  document.getElementById('summary').textContent=data.summary||'';
  document.getElementById('meta').textContent=data.location+' · '+(data.fetchedAt||'');
  document.getElementById('updated').textContent='Last update: '+new Date().toLocaleTimeString();

  document.getElementById('provider').textContent=data.provider||'--';
  document.getElementById('alertCount').textContent=(data.alerts||[]).length;
  document.getElementById('riskCount').textContent=(data.riskReport?.risks||[]).length;

  const code=data.current?.weatherCode;
  document.getElementById('weatherIcon').textContent=iconFor(code);
  document.getElementById('temp').textContent=(data.current?.temperature??'--')+'°';
  document.getElementById('condition').textContent=data.current?.condition||'--';
  document.getElementById('wind').textContent=(data.current?.windKmh??'--')+' km/h';
  document.getElementById('gust').textContent=(data.current?.gustKmh??'--')+' km/h';
  document.getElementById('rainNow').textContent=((data.hourly||[])[0]?.precipitationMm??0)+' mm';
  document.getElementById('code').textContent=code??'--';

  const risks=data.riskReport?.risks||[];
  document.getElementById('risks').innerHTML=risks.length
    ? risks.map(r=>'<span class="risk">'+r+'</span>').join('')
    : '<div class="ok">✓ No major risks detected.</div><p class="muted">Weather conditions are within normal range.</p>';

  document.getElementById('actions').textContent=risks.length
    ? 'Check outdoor materials, windows, irrigation, and exposed equipment.'
    : 'No action required.';

  document.getElementById('hours').innerHTML=(data.hourly||[]).slice(0,12).map(h=>{
    const t=h.time?new Date(h.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'--';
    const risky=(h.gustKmh||0)>60||[95,96,99].includes(h.weatherCode);
    const rainy=(h.rainChance||0)>30||(h.precipitationMm||0)>0;
    const cls=risky?'hour danger':rainy?'hour rainy':'hour';
    return '<div class="'+cls+'">'+
      '<div class="time">'+t+'</div>'+
      '<div class="hicon">'+iconFor(h.weatherCode)+'</div>'+
      '<div class="htemp">'+(h.temperature??'--')+'°</div>'+
      '<div class="rain">'+(h.rainChance??'--')+'%</div>'+
      '<div class="wind">↗ '+(h.windKmh??'--')+' / '+(h.gustKmh??'--')+'</div>'+
    '</div>';
  }).join('');
}

initMap();
loadWeather();
loadRadar();
setInterval(loadWeather,5*60*1000);
setInterval(loadRadar,5*60*1000);
</script>
</body>
</html>`;
  }
}
