<template>
<section
  class="result-diagram"
  :class="failed ? 'failed':'success'"
>

<div class="diagram-node">
🤖
<span>Request</span>
</div>

<div class="line"></div>

<div class="diagram-node">
📡
<span>Command</span>
</div>

<div class="line"></div>


<div class="diagram-node">
💡
<span>Device</span>
</div>

<div class="line"></div>


<div
 class="diagram-node"
>
<span>
{{ failed ? '❌' : '✅' }}
</span>

<span>
{{ failed ? 'Failed' : 'Settled' }}
</span>

</div>


<p>
{{ failed 
 ? 'No matching telemetry or verification failure'
 : 'Device reached requested state'
}}
</p>


</section>
</template>


<script setup lang="ts">

const props = defineProps<{
 trace:{
  outcome:string
 }
}>()


const failed =
 props.trace.outcome !== 'settled'

</script>


<style scoped>

.result-diagram{
 margin-top:24px;
 padding:24px;
 border-radius:18px;
 border:1px solid;
 text-align:center;
}


.success{
 background:#f0fdf4;
 border-color:#16a34a;
}


.failed{
 background:#fef2f2;
 border-color:#dc2626;
}


.diagram-node{
 display:flex;
 justify-content:center;
 align-items:center;
 gap:10px;
 font-weight:700;
}


.line{
 height:24px;
 width:2px;
 background:#cbd5e1;
 margin:8px auto;
}


p{
 margin-top:16px;
 color:#64748b;
}

</style>
