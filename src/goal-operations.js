// R: Map authorized goal Tool operations to App Server get/set/clear with optimistic checks and readback.
import {digest,canonical} from './operation-journal.js';
import {requireValue} from './errors.js';
export async function getGoal(b,thread){const r=await b.request('thread/goal/get',{threadId:thread});requireValue(Object.hasOwn(r,'goal')&&(r.goal===null||r.goal?.threadId===thread),'BACKEND_PROTOCOL','Unexpected goal identity.');return{goal:r.goal,goal_digest:digest(r.goal)};}
export async function mutateGoal(b,name,a,{caller,submit,suppression}){
 const t=await b.readThread(a.thread_id);requireValue(t.canAcceptDirectInput===true,'DIRECT_INPUT_UNAVAILABLE','Goal mutations require an ordinary direct-input chat.');const before=await getGoal(b,a.thread_id);
 if(a.expected_goal_digest)requireValue(a.expected_goal_digest===before.goal_digest,'GOAL_CONFLICT','Goal changed since observation; this is a local check, not server CAS.');
 let params={threadId:a.thread_id,origin:a.origin},method='thread/goal/set',kind='goal_updated';
 if(name==='as_goal_clear'){method='thread/goal/clear';kind='goal_cleared';}
 else if(name==='as_goal_pause'||name==='as_goal_resume'){requireValue(before.goal,'GOAL_NOT_FOUND','No goal to pause or resume.');const desired=name==='as_goal_pause'?'paused':'active';if(before.goal.status===desired)return{...before,rpc_accepted:false,no_change:true};if(name==='as_goal_pause')requireValue(['active','blocked'].includes(before.goal.status),'GOAL_STATE','Only pause an active or blocked goal; keep terminal and limit states intact.');if(name==='as_goal_resume')requireValue(before.goal.status==='paused','GOAL_STATE','Resume only a paused goal; do not bypass budget or usage limits.');params.status=desired;}
 else{requireValue(before.goal||a.objective,'INVALID_ARGUMENT','A new goal requires an objective.');requireValue(a.objective!==undefined||a.status!==undefined||a.token_budget!==undefined,'INVALID_ARGUMENT','Set requires objective, status or token_budget.');if(a.objective!==undefined)params.objective=a.objective;if(a.status!==undefined)params.status=a.status;if(a.token_budget!==undefined)params.tokenBudget=a.token_budget;}
 const window=await suppression.mark(caller,a.thread_id,[kind],a.operation_id);await submit();const response=await b.request(method,params);
 if(method.endsWith('/clear'))requireValue(typeof response.cleared==='boolean','BACKEND_PROTOCOL','Missing clear receipt.');else requireValue(response.goal?.threadId===a.thread_id,'BACKEND_PROTOCOL','Unexpected goal mutation response.');
 let after,readback='unavailable';try{after=await getGoal(b,a.thread_id);readback=(method.endsWith('/clear')?after.goal===null:canonical(after.goal)===canonical(response.goal))?'verified':'changed';}catch{}
 return{rpc_accepted:true,goal:method.endsWith('/clear')?null:response.goal,...(method.endsWith('/clear')?{cleared:response.cleared}:{}),goal_digest:digest(method.endsWith('/clear')?null:response.goal),readback,...(after?{observed_goal_digest:after.goal_digest}:{}),suppression_until:new Date(window.until_ms).toISOString(),target_turn_completed:false};
}
