"""Measure cold and tracked offline reads on displaced and rotated photographs."""
import argparse, json, time
import cv2
import numpy as np
import fast_omr_worker as omr
from benchmark_fast_omr import REAL_SCANS, TRUTHS

def fixtures():
    source = cv2.imread(str(REAL_SCANS / 'random.jpg'))
    source = cv2.resize(source, (1440, round(source.shape[0]*1440/source.shape[1])), interpolation=cv2.INTER_AREA)
    h,w = source.shape[:2]
    for angle in (0, -15, 15, -30, 30, 90, 180):
        matrix = cv2.getRotationMatrix2D((w/2, h/2), angle, 1)
        out_w = round(h*abs(matrix[0,1])+w*abs(matrix[0,0]))
        out_h = round(h*abs(matrix[0,0])+w*abs(matrix[0,1]))
        matrix[:,2] += [(out_w-w)/2, (out_h-h)/2]
        frame = cv2.warpAffine(source, matrix, (out_w,out_h), borderValue=(40,40,40))
        yield 'rotation-' + str(angle), frame
    for shift in (-200,200):
        yield 'offset-' + str(shift), cv2.warpAffine(source, np.float32([[1,0,shift],[0,1,0]]), (w,h), borderValue=(40,40,40))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--report-only',action='store_true')
    args=parser.parse_args()
    cv2.setNumThreads(2)
    omr._load_registration_templates()
    omr._get_cnn_net()
    cases=[]
    for name, frame in fixtures():
        _, encoded=cv2.imencode('.jpg',frame,[cv2.IMWRITE_JPEG_QUALITY,92])
        for frame_id in (1,2):
            start=time.perf_counter()
            result=omr.scan_image(encoded.tobytes(),{'useCnn':True,'detectSequence':True,'trackingSessionId':name,'frameId':frame_id})
            exact=''.join(result.get('answers',[])) == TRUTHS['random.jpg']
            cases.append({'name':name,'frame':frame_id,'exact':exact,'gradeable':result.get('gradeable',False),
                          'ms':round((time.perf_counter()-start)*1000),'reason':result.get('reason'),
                          'stages':result.get('stagesMs'),'timing':result.get('timingDetails')})
    passed=all(c['exact'] and c['gradeable'] for c in cases)
    print(json.dumps({'passed':passed,'cases':cases},indent=2))
    if not args.report_only:
        assert passed, [(c['name'],c['frame'],c['reason']) for c in cases if not(c['exact'] and c['gradeable'])]
if __name__=='__main__':main()
