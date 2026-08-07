<template>
  <section class="execution-flow">

    <div class="flow-header">
      <span class="eyebrow">
        Execution flow
      </span>

      <strong>
        {{ trace.action }}
      </strong>
    </div>


    <div class="flow">

      <div
        v-for="stage in stages"
        :key="stage.stage"
        class="flow-stage"
        :class="[
          stage.status
        ]"
      >

        <div class="marker">
          {{ icon(stage.stage, stage.status) }}
        </div>

        <div class="content">

          <strong>
            {{ stage.stage }}
          </strong>

          <span>
            {{ stage.message }}
          </span>

          <small>
            +{{ stageTime(stage.observedAt) }}
          </small>

        </div>

      </div>

    </div>

  </section>
</template>


<script setup lang="ts">

const props = defineProps<{
  trace: {
    action:string;
    stages:Array<{
      stage:string;
      status:string;
      message:string;
      observedAt:string;
    }>
  }
}>()


const stages = props.trace.stages


function stageTime(value:string){

  const start =
    new Date(stages[0].observedAt).getTime()

  const current =
    new Date(value).getTime()

  return `${current-start}ms`
}


function icon(stage:string,status:string){

  if(status === 'failed')
    return '!'

  if(status === 'complete')
    return '✓'

  return '•'
}

</script>


<style scoped>

.execution-flow{
 margin:20px 0;
 padding:20px;
 border-radius:18px;
 background:#f8fafc;
 border:1px solid #dbe4f5;
}


.flow-header{
 display:flex;
 justify-content:space-between;
 margin-bottom:18px;
}


.eyebrow{
 color:#2563eb;
 font-size:12px;
 font-weight:700;
}


.flow{
 display:flex;
 flex-direction:column;
}


.flow-stage{
 position:relative;
 display:flex;
 gap:14px;
 padding:12px 0;
 transition:.3s;
}

.flow-stage.active{
 transform:translateX(6px);
}

.flow-stage.active .marker{
 box-shadow:0 0 0 6px rgba(37,99,235,.15);
 border-color:#2563eb;
}

.flow-stage.played{
 opacity:.75;
}


.flow-stage:not(:last-child)::after{
 content:'';
 position:absolute;
 left:14px;
 top:38px;
 bottom:-8px;
 width:2px;
 background:#dbe4f5;
}


.marker{
 width:28px;
 height:28px;
 border-radius:50%;
 display:flex;
 align-items:center;
 justify-content:center;
 font-weight:700;
 background:white;
 border:2px solid #cbd5e1;
 z-index:1;
}


.complete .marker{
 background:#16a34a;
 color:white;
 border-color:#16a34a;
}


.failed .marker{
 background:#dc2626;
 color:white;
 border-color:#dc2626;
}


.content strong{
 display:block;
}


.content span{
 display:block;
 margin-top:4px;
 color:#64748b;
}

.content small{
 display:block;
 margin-top:6px;
 color:#94a3b8;
 font-size:12px;
}


</style>
