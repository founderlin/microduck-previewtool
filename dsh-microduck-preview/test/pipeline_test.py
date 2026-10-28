"""Pipeline invariants independent of GL and policy training."""
import sys
import unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'pipeline'))
import author_walk as author
from command_track import command_from_motion

class TimelineTests(unittest.TestCase):
    def test_motion_boundaries_and_command_alignment(self):
        author.HOME_FOOT_Z=.01
        author._HOME_ROOT_Z=.17
        params=author.validate_params({'pattern':'composite','direction':'forward','step_length_m':.04,'speed':'normal','segments':[{'kind':'straight','length_m':.1},{'kind':'hover','hover_foot':'right','lift_height_m':.04,'hold_s':.5},{'kind':'stand','hold_s':.5}]})
        clip=author.build_timeline_clip(params)
        root=np.c_[clip.root_xy,clip.root_z]
        self.assertLess(np.linalg.norm(np.diff(root,axis=0),axis=1).max(),.003)
        self.assertIn('transition',clip.phase)
        n=len(clip)
        motion={'times':(np.arange(n)*.02).tolist(),'root_pos':root.tolist(),'root_quat_wxyz':[[1,0,0,0]]*n,'contact':np.asarray(clip.contact).tolist(),'phases':clip.phase,'control_hz':50}
        command=command_from_motion(motion)
        self.assertEqual(len(command['lin_vel_x']),n)
        self.assertIn('hover',command['phase'])
        self.assertIn('stand',command['phase'])
        self.assertIn('left',command['support_foot'])
        self.assertTrue(all(np.isfinite(command['lin_vel_x'])))

    def test_turns_are_labeled_in_locomotion_only_timeline(self):
        author.HOME_FOOT_Z=.01;author._HOME_ROOT_Z=.17
        params=author.validate_params({'pattern':'composite','direction':'forward','step_length_m':.04,'speed':'normal','segments':[{'kind':'turn','turn_deg':90,'radius_m':.12},{'kind':'straight','length_m':.1}]})
        clip=author.build_timeline_clip(params)
        self.assertTrue(any(':turn|' in v for v in clip.phase))
        self.assertTrue(any(':straight|' in v for v in clip.phase))

    def test_velocity_uses_sample_times_and_rejects_duplicate_time(self):
        motion={'times':[0,.1,.3],'root_pos':[[0,0,0],[.1,0,0],[.3,0,0]],'root_quat_wxyz':[[1,0,0,0]]*3,'contact':[[1,1],[1,0],[0,1]],'control_hz':50}
        c=command_from_motion(motion)
        self.assertEqual(c['lin_vel_x'],[0,1,1])
        motion['times']=[0,0,.3]
        with self.assertRaises(ValueError):command_from_motion(motion)

if __name__=='__main__':unittest.main()
