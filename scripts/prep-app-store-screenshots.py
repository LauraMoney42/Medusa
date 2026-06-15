#!/usr/bin/env python3
"""
Prepare App Store screenshots for upload.
- Removes alpha channels (ASC rejects alpha in app screenshots).
- Verifies dimensions are within accepted ranges.
- Optionally resizes to exact ASC sizes.

Usage:
  python3 scripts/prep-app-store-screenshots.py
"""
from PIL import Image
import os
import sys

# Accepted sizes (width, height) for portrait iOS App Store screenshots.
IOS_ACCEPTED = {
    (1290, 2796),  # 6.7"
    (1320, 2868),  # iPhone 16 Pro Max native
    (1284, 2778),  # 6.5"
    (1242, 2208),  # 5.5"
    (2048, 2732),  # iPad Pro 12.9"
    (1668, 2388),  # iPad Pro 11"
    (1640, 2360),  # iPad 10th gen
}

# Accepted Android sizes (Google Play is more flexible; these are common).
ANDROID_ACCEPTED = {
    (1080, 1920),
    (1080, 2400),
    (1440, 3200),
}


def process_directory(directory, accepted_sizes):
    issues = []
    for filename in sorted(os.listdir(directory)):
        if not filename.lower().endswith('.png'):
            continue
        path = os.path.join(directory, filename)
        with Image.open(path) as im:
            size = im.size
            mode = im.mode

            if im.mode in ('RGBA', 'LA'):
                bg = Image.new('RGB', im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                bg.save(path, 'PNG')
                print(f'[alpha-removed] {path}')
            elif im.mode != 'RGB':
                im.convert('RGB').save(path, 'PNG')
                print(f'[converted] {path} -> RGB')
            else:
                print(f'[ok] {path} {size} {mode}')

            if size not in accepted_sizes:
                issues.append(f'{filename}: size {size} not in accepted set {accepted_sizes}')
    return issues


def main():
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    all_issues = []

    quizzk_ios = os.path.join(root, 'Quizzik', 'iosScreenshots')
    quizzk_android = os.path.join(root, 'Quizzik', 'androidScreenshots')
    narrator_ios = os.path.join(root, 'TheNarrator', 'iosScreenshots')

    for d in [quizzk_ios, quizzk_android, narrator_ios]:
        if not os.path.isdir(d):
            print(f'[skip] {d} does not exist')
            continue
        if 'android' in d:
            issues = process_directory(d, ANDROID_ACCEPTED)
        else:
            issues = process_directory(d, IOS_ACCEPTED)
        if issues:
            all_issues.extend([f'{d}: {i}' for i in issues])

    if all_issues:
        print('\n[ISSUES]')
        for issue in all_issues:
            print(issue)
        sys.exit(1)
    else:
        print('\n[ALL OK]')


if __name__ == '__main__':
    main()
