<template>
  <template v-if="trace">
    <div
      class="trace-modal-backdrop"
      @click="emit('close')"
    ></div>

    <aside class="trace-modal">

      <div class="device-sheet-head">

        <div>
          <span class="eyebrow">
            Execution timeline
          </span>

          <h3>
            {{ trace.action }}
            ·
            {{ trace.outcome }}
          </h3>
        </div>

        <button
          class="icon-button"
          type="button"
          @click="emit('close')"
        >
          ×
        </button>

      </div>


      <div class="execution-summary">

        <div>
          <small>ACTOR</small>
          <strong>
            {{ trace.actor?.name || trace.actor?.type || 'Unknown' }}
          </strong>
        </div>


        <div>
          <small>DEVICE</small>
          <strong>
            {{ trace.deviceId }}
          </strong>
        </div>


        <div>
          <small>DURATION</small>
          <strong>
            {{
              trace.durationMs
                ? (trace.durationMs / 1000).toFixed(3)+'s'
                : 'running'
            }}
          </strong>
        </div>

      </div>




      <ExecutionSimulator
        :trace="trace"
      />





    </aside>
  </template>
</template>


<script setup lang="ts">

import ExecutionSimulator from './ExecutionSimulator.vue'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'


const props = defineProps<{
  trace: {
    action:string;
    outcome:string;
    deviceId:string;
    durationMs:number|null;
    actor?:{
      type:string;
      name?:string;
    };
    stages:Array<{
      stage:string;
      status:string;
      message:string;
      observedAt:string;
    }>;
  } | null
}>()



const visibleStages = ref<any[]>([])

let replayTimer:any = null


const replayTrace = computed(()=>{

  if(!props.trace)
    return null

  return {
    ...props.trace,
    stages: visibleStages.value
  }

})



function replay(){

  visibleStages.value=[]

  let index=0

  replayTimer=setInterval(()=>{

    visibleStages.value.push(
      props.trace.stages[index]
    )

    index++

    if(index >= props.trace!.stages.length){
      clearInterval(replayTimer)
    }

  },800)

}


onMounted(()=>{
  replay()
})


onBeforeUnmount(()=>{
  if(replayTimer)
    clearInterval(replayTimer)
})

const emit = defineEmits<{
  close:[]
}>()

</script>
