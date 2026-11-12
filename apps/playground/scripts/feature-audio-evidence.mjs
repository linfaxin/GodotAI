export const AUDIO_SILENCE_THRESHOLD=0.001;
export const AUDIO_MAX_DRAIN_MS=300;
export const AUDIO_MIN_QUIET_MS=500;

/** Validate observed samples, including the complete tail, rather than assuming
 * every browser has drained its real audio queue at one fixed instant. */
export function assessStoppedAudio(samples){
 const failed=error=>({status:'failed',error});
 if(!Array.isArray(samples)||!samples.length)return failed('missing stopped samples');
 for(let i=0;i<samples.length;i++){
  const sample=samples[i];
  if(!Number.isFinite(sample.ms)||sample.ms<0||!Number.isFinite(sample.peak)||sample.peak<0||(i&&sample.ms<=samples[i-1].ms))return failed('invalid stopped sample');
 }
 let lastAudible=-1;
 for(let i=0;i<samples.length;i++)if(samples[i].peak>=AUDIO_SILENCE_THRESHOLD)lastAudible=i;
 const quiet=samples.slice(lastAudible+1);
 if(!quiet.length)return failed('playback never became silent');
 if(quiet[0].ms>AUDIO_MAX_DRAIN_MS)return failed('audio tail exceeded the bounded drain interval');
 for(let i=1;i<quiet.length;i++)if(quiet[i].ms-quiet[i-1].ms>100)return failed('stopped sampling has an observation gap');
 const quietMs=quiet.at(-1).ms-quiet[0].ms;
 if(quietMs<AUDIO_MIN_QUIET_MS)return failed('continuous silence was observed for less than 500 ms');
 return {status:'passed',drainMs:quiet[0].ms,quietMs,quietSamples:quiet.length,stoppedPeak:Math.max(...quiet.map(sample=>sample.peak))};
}
