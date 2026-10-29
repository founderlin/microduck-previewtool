#!/usr/bin/env python3
"""Real training callables on kinematic observations; never a policy prediction."""
from __future__ import annotations
import argparse
import hashlib
import importlib
import inspect
import json
import os
from pathlib import Path
from types import SimpleNamespace as NS

import numpy as np
from scipy.spatial.transform import Rotation
from command_track import command_from_motion


def perturb(motion, spec):
    out = json.loads(json.dumps(motion))
    q = np.asarray(out['root_quat_wxyz'])
    r = Rotation.from_quat(q[:, [1, 2, 3, 0]])
    t = np.asarray(out['times'])
    kind = spec['type']
    if kind == 'tilt_root': r = r * Rotation.from_euler('y', np.full((len(t), 1), spec.get('pitch_deg', 10)), degrees=True)
    elif kind == 'root_wobble': r = r * Rotation.from_euler('x', (spec.get('amp_deg', 8) * np.sin(t * 6))[:, None], degrees=True)
    elif kind == 'scale_yaw_rate':
        e = r.as_euler('xyz'); e[:, 2] = e[0, 2] + np.unwrap(e[:, 2] - e[0, 2]) * spec.get('factor', .3); r = Rotation.from_euler('xyz', e)
    elif kind == 'scale_forward_speed':
        root = np.asarray(out['root_pos']); root[:, :2] = root[0, :2] + (root[:, :2] - root[0, :2]) * spec.get('factor', .4); out['root_pos'] = root.tolist()
    elif kind == 'stance_foot_drift':
        joints = np.asarray(out['joint_pos']); joints[:, :min(10, joints.shape[1])] += .08 * np.sin(t[:, None] * 9); out['joint_pos'] = joints.tolist()
    else: raise ValueError('No verified kinematic perturbation adapter for this term')
    q = r.as_quat(); out['root_quat_wxyz'] = q[:, [3, 0, 1, 2]].tolist()
    return out


def observations(motion, model):
    import mujoco
    import torch
    times = np.asarray(motion['times']); q = np.asarray(motion['root_quat_wxyz'])
    rot = Rotation.from_quat(q[:, [1, 2, 3, 0]])
    root = np.asarray(motion['root_pos']); vel = np.gradient(root, times, axis=0)
    omega = np.zeros_like(vel)
    omega[1:] = (rot[:-1].inv() * rot[1:]).as_rotvec() / np.diff(times)[:, None]
    data = mujoco.MjData(model); qa = [model.joint(n).qposadr[0] for n in motion['joint_names']]
    feet = []
    for i in range(len(times)):
        data.qpos[:3] = root[i]; data.qpos[3:7] = q[i]; data.qpos[qa] = motion['joint_pos'][i]
        mujoco.mj_forward(model, data)
        feet.append([data.site('left_foot').xpos.copy(), data.site('right_foot').xpos.copy()])
    feet = np.asarray(feet)
    tensor = lambda v: torch.as_tensor(np.asarray(v), dtype=torch.float32)
    return NS(root_link_lin_vel_b=tensor(rot.inv().apply(vel)), root_link_ang_vel_b=tensor(omega),
              root_link_quat_w=tensor(q), gravity_vec_w=tensor(np.tile([0, 0, -1], (len(times), 1))),
              body_link_ang_vel_w=tensor(rot.apply(omega)[:, None, :]),
              site_lin_vel_w=tensor(np.gradient(feet, times, axis=0)))


def score_term(term, motion, command, model):
    import torch
    module, name = term['function'].split(':')
    fn = getattr(importlib.import_module(module), name)
    data = observations(motion, model)
    cmd = torch.tensor(np.c_[command['lin_vel_x'], np.zeros(len(command['times'])), command['ang_vel_z']], dtype=torch.float32)
    contact = NS(data=NS(found=torch.tensor(motion['contact'])))
    env = NS(scene={'robot': NS(data=data), 'feet_ground_contact': contact}, command_manager=NS(get_command=lambda _: cmd), extras={'log': {}}, num_envs=len(cmd), device='cpu')
    params = {k: v.get('default') for k, v in term.get('params', {}).items()}
    params.update(term.get('selected', {}).get('params', {})); params.update(term.get('fixed_params', {}))
    if name in ('upright', 'body_angular_velocity_penalty', 'feet_slip'):
        params['asset_cfg'] = NS(name='robot', body_ids=[0] if name == 'body_angular_velocity_penalty' else [], site_ids=[0, 1])
    if inspect.isclass(fn): fn = fn(NS(params=params), env)
    with torch.no_grad(): values = fn(env, **params).cpu().numpy()
    phases = term.get('selected', {}).get('active_phases', ['all'])
    mask = np.ones(len(values)) if 'all' in phases else np.isin(command['phase'], phases).astype(float)
    weight = term.get('selected', {}).get('weight', term['weight']['default'])
    weighted = values * mask * weight
    return {'weighted_values': weighted.tolist(), 'weight': weight, 'active_phases': phases, 'backend': 'training_function', 'function': term['function'], 'source': inspect.getsourcefile(type(fn) if not inspect.isfunction(fn) else fn), 'values': values.tolist(), 'mean': float(values.mean()), 'note': '真实奖励函数；输入为运动学观测，接触标签来自参考，不是动力学传感器或策略回放。'}


def render_comparison(original, changed, scores, model, out):
    import mujoco
    import imageio.v2 as imageio
    from PIL import Image, ImageDraw
    renderer = mujoco.Renderer(model, height=240, width=320); data = mujoco.MjData(model)
    qa = [model.joint(n).qposadr[0] for n in original['joint_names']]
    cam = mujoco.MjvCamera(); cam.azimuth=130; cam.elevation=-18; cam.distance=.7
    indices = np.linspace(0, len(original['times'])-1, 36).astype(int)
    writer = imageio.get_writer(str(out), fps=12, codec='libx264', pixelformat='yuv420p')
    try:
        values = [np.asarray(v['values']) for v in scores]; low=min(v.min() for v in values); span=max(1e-6, max(v.max() for v in values)-low)
        for index in indices:
            canvas = Image.new('RGB', (640, 320), '#16201f'); draw=ImageDraw.Draw(canvas)
            for j, motion in enumerate((original, changed)):
                data.qpos[:3]=motion['root_pos'][index]; data.qpos[3:7]=motion['root_quat_wxyz'][index]; data.qpos[qa]=motion['joint_pos'][index]; data.qvel[:]=0; mujoco.mj_forward(model,data)
                cam.lookat[:]=[*motion['root_pos'][index][:2], .075]; renderer.update_scene(data,camera=cam); canvas.paste(Image.fromarray(renderer.render()),(j*320,0))
                draw.text((j*320+10,10), ('REFERENCE' if j==0 else 'PERTURBED')+f'  {values[j][index]:.4f}', fill='white')
                points=[(10+k/(len(values[j])-1)*620, 302-(float(v)-low)/span*45) for k,v in enumerate(values[j])]
                draw.line(points,fill=('#80dec5' if j==0 else '#ffb578'),width=2)
            draw.text((10,242), 'Same training function | Kinematic inputs | Not a learned policy', fill='white')
            writer.append_data(np.asarray(canvas))
    finally: writer.close(); renderer.close()


def comparison_motion(original, changed):
    """One scene: reference, perturbed reference, reference; blend transitions."""
    count = min(len(original['times']), 150)
    indices = np.linspace(0, len(original['times']) - 1, count).astype(int)
    keys = ('joint_pos', 'root_pos', 'root_quat_wxyz')
    rows = {k: [] for k in keys}
    stages = []
    for stage, motion in (('正常', original), ('扰动', changed), ('恢复', original)):
        for k in keys:
            arr = np.asarray(motion[k], float)[indices]
            if rows[k]:
                start = np.asarray(rows[k][-1]); end = arr[0].copy()
                if k == 'root_quat_wxyz' and np.dot(start, end) < 0: end = -end
                for w in np.linspace(0, 1, 12, endpoint=False)[1:]:
                    item = (1-w)*start + w*end
                    if k == 'root_quat_wxyz': item /= np.linalg.norm(item)
                    rows[k].append(item.tolist())
            rows[k].extend(arr.tolist())
        if stages: stages.extend(['过渡'] * 11)
        stages.extend([stage] * count)
    return {'schema_version': 1, 'joint_names': original['joint_names'], 'control_hz': 50,
            'times': (np.arange(len(stages)) / 50).tolist(), 'stages': stages, **rows}

def main():
    p=argparse.ArgumentParser();p.add_argument('--motion-json',type=Path,required=True);p.add_argument('--term-json',type=Path,required=True);p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--asset-root',type=Path,required=True);p.add_argument('--command-json',type=Path);p.add_argument('--trajectory-only',action='store_true')
    a=p.parse_args();t=json.loads(a.term_json.read_text());m=json.loads(a.motion_json.read_text());a.out_dir.mkdir(parents=True,exist_ok=True)
    __import__('sys').path.insert(0, str(a.asset_root/'src'))
    os.environ.setdefault('MPLCONFIGDIR',str(a.out_dir/'.mpl'))
    if not t.get('kinematic_evaluable'):
        result={'term_id':t['id'],'status':'training_only','video':None,'caption':'仅训练后可见；缺少真实传感器或控制器状态，不生成替代得分/假动画。'}
    else:
        import mujoco
        model=mujoco.MjModel.from_xml_path(str(a.asset_root/'src/mjlab_microduck/robot/microduck/robot_groundcontact.xml'))
        command=json.loads(a.command_json.read_text()) if a.command_json and a.command_json.is_file() else command_from_motion(m)
        changed=perturb(m,t['explain']['perturbation']);scores=[score_term(t,v,command,model) for v in (m,changed)]
        trajectory=comparison_motion(m,changed)
        (a.out_dir/'motion.json').write_text(json.dumps(trajectory,ensure_ascii=False,allow_nan=False))
        if not a.trajectory_only: render_comparison(m,changed,scores,model,a.out_dir/'explain.mp4')
        result={'term_id':t['id'],'status':'ready','video':None if a.trajectory_only else 'explain.mp4','duration_s':trajectory['times'][-1], 'stages':trajectory['stages'], 'times':m['times'],'original':scores[0],'perturbed':scores[1],'caption':'正常参考 vs 受控扰动；同一训练函数评分，不预测改变权重后的策略。'}
    (a.out_dir/'scores.json').write_text(json.dumps(result,ensure_ascii=False,allow_nan=False,indent=2)+'\n')
    print(json.dumps({'status':result['status']}))
if __name__=='__main__':main()
