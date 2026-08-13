<template>
<section class="execution-simulator">

  <div class="simulator-header">

    <div>
      <span class="eyebrow">
        Execution replay
      </span>

      <h3>
        {{ trace.action }} lifecycle
      </h3>
    </div>

  </div>


  <div class="flow">

    <div
      v-for="node in nodes"
      :key="node.stage"
      class="flow-node"
      :class="[
        node.status
      ]"
    >

      <div class="icon">
        {{ node.icon }}
      </div>


      <div>
        <strong>
          {{ node.stage }}
        </strong>

        <small>
          {{ node.message }}
        </small>
      </div>


      <span>
        {{ node.status === 'done' ? '✓' : '' }}
      </span>


    </div>

  </div>


</section>
</template>


<script setup lang="ts">

import { computed, onMounted, ref } from 'vue'


const props = defineProps<{
  trace:{
    action:string;
    stages:Array<{
      stage:string;
      message:string;
      status:string;
    }>
  }
}>()


const nodes = ref<any[]>([])


function icon(stage:string){

  const map:Record<string,string> = {
    requested:'🤖',
    published:'📡',
    reported:'📥',
    verified:'🔍',
    settling:'⏳',
    settled:'✅',
    timed_out:'❌',
    failed:'❌'
  }

  return map[stage] || '⚙️'
}


function buildNodes(){

  nodes.value =
    props.trace.stages.map(stage=>({
      ...stage,
      icon:icon(stage.stage),
      status:'idle'
    }))

}


async function replay(){

  for(const node of nodes.value){

    node.status='active'

    await delay(450)

    node.status='done'

  }

}


function delay(ms:number){
 return new Promise(resolve=>setTimeout(resolve,ms))
}


onMounted(()=>{

 buildNodes()

 replay()

})


</script>


<style scoped>

.execution-simulator{
padding:24px;
border:1px solid #dbe4f5;
border-radius:18px;
background:white;
margin-bottom:20px;
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
border:1px solid #e1e8f5;
transition:.3s;
}


.flow-node.active{
border-color:#2563eb;
background:#eff6ff;
}


.flow-node.done{
border-color:#16a34a;
background:#f0fdf4;
}


.icon{
font-size:24px;
}


small{
display:block;
color:#64748b;
}

</style>
