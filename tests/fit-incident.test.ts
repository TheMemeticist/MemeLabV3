import { describe, it, expect, vi } from 'vitest';
import {
  incidentCountTerms, incidentPoissonNLL, poissonNLL, mse, lossOf,
  goodnessOfFit, runFit, findFitParam, profileOffsetCI, metropolisChain,
} from '../src/lib/fit';
import type { ObservedPoint, SimCurves } from '../src/lib/fit';
import { baseSimConfig } from '../src/sim/presets';
const point = (day:number,value:number,category:ObservedPoint['category']='cumulative_infections'):ObservedPoint => ({day,value,category});
const curves = (infections:number[],deaths=infections.map(()=>0),active=infections.map(()=>0)):SimCurves => ({cumulative_infections:infections,cumulative_deaths:deaths,active_infections:active});
const nll = (observed:number,expected:number) => Math.max(expected,1e-9)-observed*Math.log(Math.max(expected,1e-9));

describe('incident Poisson observation contract',()=>{
  it('anchors the full first cumulative stock once, including a nonzero first model day',()=>{
    const observed=[point(2,20),point(5,37),point(9,80)];
    const simulated=curves([.01,.10,.20,.25,.31,.37,.41,.45,.60,.80]);
    expect(incidentCountTerms(observed)).toEqual([
      {category:'cumulative_infections',day:2,previousDay:null,value:20,kind:'initial_cumulative'},
      {category:'cumulative_infections',day:5,previousDay:2,value:17,kind:'interval_cumulative'},
      {category:'cumulative_infections',day:9,previousDay:5,value:43,kind:'interval_cumulative'},
    ]);
    expect(incidentPoissonNLL(observed,simulated,100)).toBeCloseTo(nll(20,20)+nll(17,17)+nll(43,43),12);
  });
  it('uses whole variable-length interval counts, never a daily rate or imputed missing report',()=>{
    const observed=[point(0,5),point(2,13),point(7,33)];
    const simulated=curves([.05,.09,.13,.17,.21,.25,.29,.33]);
    expect(incidentPoissonNLL(observed,simulated,100)).toBeCloseTo(nll(5,5)+nll(8,8)+nll(20,20),12);
    expect(incidentPoissonNLL(observed,simulated,100)).not.toBeCloseTo(nll(5,5)+nll(4,4)+nll(4,4),5);
  });
  it('keeps category intervals separate and active prevalence as levels even when prevalence falls',()=>{
    const observed=[point(2,4,'active_infections'),point(2,20),point(0,2,'cumulative_deaths'),point(0,10),point(2,3,'cumulative_deaths'),point(0,8,'active_infections')];
    const simulated=curves([.1,.15,.2],[.02,.02,.03],[.08,.06,.04]);
    expect(incidentPoissonNLL(observed,simulated,100)).toBeCloseTo(nll(10,10)+nll(10,10)+nll(2,2)+nll(1,1)+nll(8,8)+nll(4,4),12);
    expect(incidentCountTerms(observed).filter(p=>p.category==='active_infections').map(p=>[p.kind,p.value,p.previousDay])).toEqual([['active_level',8,null],['active_level',4,null]]);
  });
  it('is order invariant, does not mutate inputs, and adding later data adds only its new interval term',()=>{
    const observed=[point(5,9),point(0,1),point(2,3)];const before=structuredClone(observed);
    const simulated=curves([.01,.02,.03,.05,.07,.09,.15]);
    const first=incidentPoissonNLL(observed,simulated,100);
    expect(incidentPoissonNLL(observed.slice().reverse(),simulated,100)).toBe(first);
    expect(observed).toEqual(before);
    expect(incidentPoissonNLL([...observed,point(6,15)],simulated,100)-first).toBeCloseTo(nll(6,6),12);
    const poisonedFuture=curves([...simulated.cumulative_infections.slice(0,6),NaN,Infinity,-1]);
    expect(incidentPoissonNLL(observed,poisonedFuture,100)).toBe(first);
  });
  it('retains zero-incidence intervals with the existing epsilon convention',()=>{
    expect(incidentPoissonNLL([point(0,1),point(1,1)],curves([.01,.01]),100)).toBeCloseTo(nll(1,1)+nll(0,0),14);
  });
  it('rejects downward cumulative revisions without clipping or changing the observations',()=>{
    const observed=[point(0,10),point(7,8)];const before=structuredClone(observed);
    expect(()=>incidentPoissonNLL(observed,curves(Array(8).fill(.1)),100)).toThrow(/downward cumulative revision.*days 0 and 7/);
    expect(observed).toEqual(before);
  });
  it('rejects duplicate days per category, ambiguous fractional days, and nonfinite/negative counts',()=>{
    for(const observed of [[point(1,1),point(1,1)],[point(.5,1)],[point(-1,1)],[point(Infinity,1)],[point(0,-1)],[point(0,NaN)],[point(0,Infinity)]]) {
      expect(()=>incidentCountTerms(observed)).toThrow(/Incident Poisson/);
    }
    expect(()=>incidentCountTerms([point(1,1),point(1,1,'active_infections')])).not.toThrow();
  });
  it('rejects insufficient model coverage, decreasing cumulative model endpoints, and invalid population',()=>{
    expect(()=>incidentPoissonNLL([point(2,1)],curves([0,.1]),100)).toThrow(/simulation must cover/);
    expect(()=>incidentPoissonNLL([point(0,1),point(1,2)],curves([.2,.1]),100)).toThrow(/invalid simulated cumulative increment/);
    for(const population of [0,-1,Infinity,NaN])expect(()=>incidentPoissonNLL([point(0,1)],curves([.1]),population)).toThrow(/positive population/);
  });
});

describe('incident fitting integration without changing existing objectives',()=>{
  it('preserves exact legacy Poisson and MSE values and routes the new mode explicitly',()=>{
    const observed=[point(0,3),point(2,8)];const simulated=curves([.02,.04,.07]);
    expect(lossOf(observed,simulated,100,'poisson')).toBe(poissonNLL(observed,simulated,100));
    expect(lossOf(observed,simulated,100,'mse')).toBe(mse(observed,simulated,100));
    expect(lossOf(observed,simulated,100,'poisson_incident')).toBe(incidentPoissonNLL(observed,simulated,100));
    expect(poissonNLL(observed,simulated,100)).toBe(nll(3,2)+nll(8,7.000000000000001));
    expect(mse(observed,simulated,100)).toBe(((2-3)**2+(.07*100-8)**2)/2);
  });
  it('validates revisions before asking the simulation executor to allocate a candidate',async()=>{
    const simulate=vi.fn();
    await expect(runFit({baseConfig:baseSimConfig('bdbv'),params:[findFitParam('attackRate')],observed:[point(0,5),point(1,4)],population:100,loss:'poisson_incident',K:1,simulate})).rejects.toThrow(/downward cumulative revision/);
    expect(simulate).not.toHaveBeenCalled();
  });
  it('uses the same shifted interval endpoints during offset search, final scoring and held-out evaluation',async()=>{
    const result=await runFit({baseConfig:baseSimConfig('bdbv'),params:[{...findFitParam('attackRate'),bounds:[.1,.9]}],observed:[point(1,10),point(4,25),point(7,40)],population:200,loss:'poisson_incident',K:1,K0:1,optimizer:'local',budget:16,nmIters:4,restarts:1,offset:{bounds:[0,2]},extraDays:3,
      simulate:async(config,days)=>({curves:curves(Array.from({length:days+1},(_,day)=>(day+1)*config.strain.attackRate/20)),rNaught:config.strain.attackRate*4}),
    });
    expect(result.loss).toBe(incidentPoissonNLL(result.observed,result.simulated,result.population));
    expect(result.holdout?.loss).toBe(result.loss);
    expect(result.observed[0].day).toBe(1+(result.indexOffset??0));
  });
  it('uses Poisson deviance, rather than the MSE transform, for offset profiles and posterior acceptance',async()=>{
    const profile=[{offset:0,loss:-20},{offset:1,loss:-21},{offset:2,loss:-18}];
    expect(profileOffsetCI(profile,1,'poisson_incident',10)).toEqual(profileOffsetCI(profile,1,'poisson',10));
    const params=[{...findFitParam('attackRate'),bounds:[.1,.9] as [number,number]}];
    const objective=async(values:number[])=>((values[0]-.4)**2)*20-10;
    const legacy=await metropolisChain(objective,[.5],params,123,30,10,'poisson',10);
    const incident=await metropolisChain(objective,[.5],params,123,30,10,'poisson_incident',10);
    expect(incident).toEqual(legacy);
  });
});

describe('goodness-of-fit numeric range',()=>{
  it('returns an explicitly unavailable R² instead of Infinity for tiny observed variance',()=>{
    const result=goodnessOfFit([point(0,1e-160),point(1,2e-160)],curves([1,1]),1);
    expect(result.r2).toBeNull();expect(result.rmse).toBe(1);expect(result.r2UndefinedReason).toMatch(/finite R²/);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('preserves normal perfect fits, constant-series convention and empty-data defaults',()=>{
    expect(goodnessOfFit([point(0,1),point(1,2)],curves([.1,.2]),10)).toEqual({rmse:0,r2:1});
    expect(goodnessOfFit([point(0,1),point(1,1)],curves([.1,.1]),10)).toEqual({rmse:0,r2:0});
    expect(goodnessOfFit([],curves([]),10)).toEqual({rmse:0,r2:1});
  });
});
