"""Validate the generated archive before scheduled jobs publish it."""
from pathlib import Path
import argparse,json,math
from observation_quality import POLICY_VERSION


def validate(path: Path) -> dict:
    payload=json.loads(path.read_text())
    if payload.get('qualityPolicyVersion')!=POLICY_VERSION:
        raise ValueError('Archive quality policy is missing or stale')
    city_count=0
    for day in payload.get('days',[]):
        values=day['v'];n=len(values)
        if any(len(day.get(key,[]))!=n for key in ('q','s','g')):
            raise ValueError(f"Unaligned value/source/quality arrays on {day['d']}")
        for value,source,quality,span in zip(values,day['s'],day['q'],day['g']):
            if value is None:
                if source!='-' or quality!='-':raise ValueError(f"Missing sample has a measured source on {day['d']}")
                continue
            if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value):raise ValueError('Nonfinite water level')
            if source not in 'NS' or quality not in 'MICU':raise ValueError('Unknown observation provenance')
            if quality=='M' and span!=0:raise ValueError('Exact observation has an interpolation span')
            if quality=='I' and (span is None or not 0<span<=1800):raise ValueError('Interpolation exceeds the 30-minute policy')
            if source=='N':city_count+=1
        if day.get('n',0)!=day['s'].count('N'):raise ValueError('Daily city count differs from per-sample provenance')
        peak=max((v for v in values if v is not None),default=None)
        if day.get('p')!=peak:raise ValueError('Daily peak differs from the displayed samples')
    if payload['quality']['cityQuarterHours']!=city_count:raise ValueError('Archive city count differs from sample provenance')
    return {'days':len(payload['days']),'cityQuarterHours':city_count,'qualityPolicyVersion':POLICY_VERSION}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('archive',nargs='?',type=Path,default=Path('observed15min.json'))
    print(json.dumps(validate(parser.parse_args().archive),indent=2))
