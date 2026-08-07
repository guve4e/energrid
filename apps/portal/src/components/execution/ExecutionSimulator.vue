<template>
<section class="execution-simulator">

  <div class="replay-header">
    <span class="eyebrow">Execution replay</span>
    <h3>{{ trace.action }} lifecycle</h3>
  </div>


  <div class="flow">

    <div
      v-for="(stage,index) in visibleStages"
      :key="stage.stage"
      class="flow-node"
      :class="[
        stage.status,
        stage.status === 'complete' ? 'success' : '',
        stage.status === 'failed' ? 'error' : ''
      ]"
    >

      <div class="icon">
        {{ icon(stage.stage) }}
      </div>


      <div class="content">

        <strong>
          {{ title(stage.stage) }}
        </strong>

        <small>
          {{ stage.message }}
        </small>

      </div>


      <span class="result">
        {{ stage.status === 'complete' ? '✓' : stage.status === 'failed' ? '!' : '' }}
      </span>

      <span class="time">
        +{{ stageTime(stage.observedAt) }}
      </span>

    </div>

  </div>

</section>
</template>


<script setup lang="ts">

import {ref,onMounted,onBeforeUnmount} from 'vue'


const props = defineProps<{
 trace:{
  action:string;
  stages:Array<{
   stage:string;
   status:string;
   message:string;
   observedAt:string;
  }>
 }
}>()


const visibleStages = ref<any[]>([])

let timer:any=null


onMounted(()=>{

 let index=0

 timer=setInterval(()=>{

   visibleStages.value.push(
     props.trace.stages[index]
   )

   index++

   if(index >= props.trace.stages.length){
     clearInterval(timer)
   }

 },350)

})


onBeforeUnmount(()=>{

 if(timer)
   clearInterval(timer)

})


function title(stage:string){

 const map:any={
  requested:'Command request',
  published:'Adapter',
  reported:'Physical device',
  verified:'Verification',
  settling:'Settlement',
  settled:'Stable state',
 timed_out:'Timeout'
 }

 return map[stage] || stage
}



function icon(stage:string){

 const map:any={
  requested:'🤖',
  published:'📡',
  reported:'💡',
  verified:'🔍',
  settling:'⌛',
  settled:'✅',
 timed_out:'❌'
 }

 return map[stage] || '⚙️'
}



function stageTime(value:string){

 const start =
  new Date(props.trace.stages[0].observedAt).getTime()

 const current =
  new Date(value).getTime()


 return `${current-start}ms`

}


</script>


<style scoped>

.execution-simulator{

padding:24px;
border:1px solid #dbe4f5;
border-radius:18px;
background:white;

}


.replay-header{
margin-bottom:20px;
}


.eyebrow{
color:#2563eb;
font-size:12px;
font-weight:700;
}


h3{
margin:5px 0;
}


.flow{
display:flex;
flex-direction:column;
gap:12px;
}


.flow-node{

display:flex;
align-items:center;
gap:14px;

padding:14px;

border-radius:14px;

border:1px solid #cbd5e1;

background:white;

animation:appear .35s ease;

}


.icon{
font-size:24px;
}


.content{
flex:1;
}


.content small{

display:block;

margin-top:4px;

color:#64748b;

}


.time{

font-size:12px;

color:#94a3b8;

}


@keyframes appear{

from{
 opacity:0;
 transform:translateY(8px);
}

to{
 opacity:1;
 transform:none;
}

}

</style>
