"""Shared read-only expected export contract; never infer reduced scope from missing files."""
from __future__ import annotations


def delivery_contract(checkpoint, project):
    identity=checkpoint.get('identity',{})
    mode=identity.get('mode','complete')
    errors=[]
    if mode not in ('complete','mixes'):
        errors.append('Unknown explicit delivery mode')
        mode='complete'
    plan=[{'name':'mix.wav','tap':'mix'},{'name':'headroom.wav','tap':'headroom'}]
    if mode=='complete':
        plan += [{'name':'instrumental.wav','tap':'mix','instrumentalOnly':True},
                 {'name':'instrumental-headroom.wav','tap':'headroom','instrumentalOnly':True}]
        candidate=project.get('candidates',[{}])[project.get('selected',0)]
        roles=set(t['id'] for t in candidate.get('tracks',[])) | set(c['role'] for c in project.get('clips',[])) | {'tag','vox'}
        plan += [{'name':f'stem-{role}-dry.wav','tap':role} for role in sorted(roles)]
        plan += [{'name':'stem-fx.wav','tap':'fx'},{'name':'stem-fx-instrumental.wav','tap':'fx','instrumentalOnly':True}]
    actual=identity.get('renderPlan',[])
    canonical=lambda row:(row.get('name'),row.get('tap'),bool(row.get('instrumentalOnly',False)))
    if len(actual)!=len({x.get('name') for x in actual}):errors.append('Duplicate declared render-plan output')
    if sorted(map(canonical,actual))!=sorted(map(canonical,plan)):
        errors.append(f'Render plan does not match explicit {mode} delivery mode')
    artifacts={'project.ish.json','score.mid','portable-project.zip'}
    if mode=='complete':artifacts.add('README.txt')
    if not artifacts.issubset(identity.get('artifactNames',[])):
        errors.append('Required portable project/MIDI/delivery artifacts missing from plan')
    expected=set(x['name'] for x in plan) | artifacts | set(identity.get('artifactNames',[]))
    return {'mode':mode,'requiredNames':expected,'errors':errors,
        'scope':'Listening/headroom mixes and portable project only; no stems or instrumental-only vocal-routing verification requested.' if mode=='mixes' else 'Full listening/instrumental/headroom versions, all declared role stems, both FX stems and portable project.'}
