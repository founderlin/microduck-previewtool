#!/usr/bin/env python3
"""Real reference-target BAM rollout using the training repo runtime, no PPO."""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path


def write(path,value): path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')

def bam_rollout(root, out, motion, command, task, seeds):
    sys.path[:0]=[str(root/'scripts'),str(root/'src')]
    from train_microduck_cpu import configure_cpu, TrainingStateMirror
    configure_cpu(1)
    import torch
    import numpy as np
    import mujoco
    import mjlab_microduck.tasks
    from mjlab.tasks.registry import load_env_cfg
    from mjlab.envs import ManagerBasedRlEnv
    from mjlab_microduck.robot.microduck_constants import MICRODUCK_GROUND_PICK_ROBOT_CFG
    from copy import deepcopy
    torch.set_num_threads(1)
    results=[]
    for seed in seeds:
        cfg=load_env_cfg(task,play=True);cfg.scene.num_envs=1;cfg.seed=seed
        # Use the exact ground-contact robot variant of the authored reference.
        cfg.scene.entities['robot']=deepcopy(MICRODUCK_GROUND_PICK_ROBOT_CFG)
        env=ManagerBasedRlEnv(cfg=cfg,device='cpu',render_mode=None)
        try:
            env.reset(seed=seed);robot=env.scene['robot']
            bam=[a for a in robot.actuators if getattr(a,'_bam_model',None) is not None]
            if not bam:raise ValueError('当前任务没有 BAM 执行器，拒绝用普通 PD 冒充 BAM')
            ids=[robot.find_joints(n)[0][0] for n in motion['joint_names']]
            target=torch.tensor(motion['joint_pos'][0],dtype=torch.float32).unsqueeze(0)
            robot.write_joint_state_to_sim(target,torch.zeros_like(target),joint_ids=ids)
            root_pose=torch.tensor([motion['root_pos'][0]+motion['root_quat_wxyz'][0]],dtype=torch.float32)
            root_pose[:,:3]+=env.scene.env_origins
            robot.write_root_link_pose_to_sim(root_pose)
            robot.write_root_link_velocity_to_sim(torch.zeros((1,6)))
            env.scene.write_data_to_sim();env.sim.forward();env.sim.sense()
            # Initial state only; no root fixing, external forces or motor-history writes.
            term=env.action_manager.get_term('joint_pos')
            action_names=list(term._target_names)
            permutation=[motion['joint_names'].index(n) for n in action_names]
            mirror=TrainingStateMirror(env);trace=[];poses=[];times=[];terminal=None
            (out/'bam-attempted.json').write_text(json.dumps({'seed':seed,'task':task}))
            for step in range(math.ceil(motion['duration_s']/env.step_dt)):
                time=step*env.step_dt;i=min(len(motion['times'])-1,round(time*50))
                desired=torch.tensor(motion['joint_pos'][i],dtype=torch.float32)[permutation].unsqueeze(0)
                action=(desired-term._offset)/term._scale
                cmd=env.command_manager.get_command('twist')
                if cmd is not None:cmd[:]=torch.tensor([command['lin_vel_x'][i],0,command['ang_vel_z'][i]])
                mirror.update(0);poses.append(mirror.data.qpos.copy());times.append(time)
                tilt=float(torch.acos((-robot.data.projected_gravity_b[0,2]).clamp(-1,1))*180/torch.pi)
                trace.append({'time':time,'tilt_deg':tilt,'joint_rmse_deg':float(torch.sqrt(((robot.data.joint_pos[:,ids]-torch.tensor(motion['joint_pos'][i]))**2).mean())*180/torch.pi)})
                _,_,terminated,truncated,_=env.step(action)
                if bool((terminated|truncated)[0]):
                    terminal={'time':(step+1)*env.step_dt,'terminated':bool(terminated[0]),'truncated':bool(truncated[0])};break
            np.savez_compressed(out/f'bam-replay-{seed}.npz',qpos=np.asarray(poses),time=np.asarray(times))
            if seed==seeds[0]:mujoco.mj_saveModel(mirror.model,str(out/'bam-model.mjb'),None)
            results.append({'seed':seed,'completed_reference':terminal is None,'first_terminal':terminal,'trace':trace})
        finally:env.close()
    return {'ran':True,'ok':True,'seeds':results,'baseline_completed':all(v['completed_reference'] for v in results),'controller':'reference joint targets through original action scale/offset and BAM','initial_state':'reference pose once; motor history untouched','root_fixed':False,'external_forces_added_by_preview':False,'environment_randomization_preserved':True,'post_terminal_autoreset_data_excluded':True,'new_PPO_updates':0}

def main():
    p=argparse.ArgumentParser();p.add_argument('--task-dir',type=Path,required=True);p.add_argument('--out-dir',type=Path,required=True);p.add_argument('--asset-root',type=Path,required=True);p.add_argument('--task',required=True);p.add_argument('--seeds',default='[123,2026]');a=p.parse_args();out=a.out_dir
    motion=json.loads((out/'motion.json').read_text());command=json.loads((out/'command.json').read_text())
    seeds=json.loads(a.seeds)
    if not isinstance(seeds,list) or not seeds or len(seeds)>4 or any(type(v) is not int for v in seeds):raise ValueError('预检种子必须为 1–4 个整数')
    # Set CPU runtime before importing MuJoCo; geometry uses the same ground model.
    import author_walk
    try:geometry=author_walk.check_geometry(author_walk.build_model(),motion)
    except Exception as exc:geometry={'ok':False,'error':str(exc)}
    try:bam=bam_rollout(a.asset_root,out,motion,command,a.task,seeds)
    except Exception as exc:bam={'attempted':True,'ran':(out/'bam-attempted.json').exists(),'ok':False,'reason':str(exc),'new_PPO_updates':0}
    sources={}
    for file in sorted((a.asset_root/'src/mjlab_microduck').rglob('*')):
        if file.is_file() and file.suffix in ('.py','.xml','.json','.stl','.obj','.ply','.urdf') and '__pycache__' not in file.parts:sources[str(file.relative_to(a.asset_root))]=hashlib.sha256(file.read_bytes()).hexdigest()
    helper=a.asset_root/'scripts/train_microduck_cpu.py'
    if helper.is_file():sources[str(helper.relative_to(a.asset_root))]=hashlib.sha256(helper.read_bytes()).hexdigest()
    write(out/'robot_sources.json',sources)
    eligible=geometry.get('ok') is True and not geometry.get('hard_error_count')
    blockers=[]
    if not eligible:blockers.append('几何硬错误须先修复')
    if not bam['ok']:blockers.append('BAM 预检未完成：'+bam.get('reason','unknown'))
    report={'schema_version':1,'geometry':geometry,'bam':bam,'eligible_for_review':eligible,'handoff_ready':eligible and bam['ok'],'handoff_blockers':blockers,'risks':[],'new_PPO_updates':0,'note':'BAM 基线失败不等于不可学习；用户须审核风险。几何通过不代表动力学、策略或实机验收。'}
    criteria=json.loads((out/'task_criteria.json').read_text())
    if not any(v is not None for k,v in criteria.items() if k!='minimum_pass_fraction'):report['risks'].append('任务联合验收阈值未配置；只报告数值，不自动判定成功')
    if bam['ok'] and not bam['baseline_completed']:report['risks'].append('原始参考控制器未完成全程；须展示动力学证据并明确接受风险后再训练')
    write(out/'physics.json',report);print(json.dumps({'ok':True,'bam_ran':bam['ran'],'handoff_ready':report['handoff_ready']}))
if __name__=='__main__':main()
