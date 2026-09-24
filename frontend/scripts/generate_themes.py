#!/usr/bin/env python3
"""테마 CSS 생성기 — src/themes.css 를 만들어낸다.

방식: 컴포넌트에 하드코딩된 Tailwind 임의값 클래스(bg-[#f7f7f5] 등)를 테마별
[data-theme="..."] 셀렉터로 덮어쓴다. 기본(노션) 테마는 오버라이드가 없으므로
현재 모습이 그대로 유지된다.

- BG/TEXT/LINE 맵: 프리픽스 그룹별 색상 치환 (같은 hex 라도 배경/글자 용도별로 다르게 매핑
  — 예: #37352f 는 본문 잉크이자 주 버튼 배경이라 다크 테마에서 서로 다른 값이 필요)
- 변형(variant): 기본 · hover · focus · focus-within · disabled · group-hover 지원
- 색을 바꾸면 이 스크립트를 수정하고 재실행: python3 scripts/generate_themes.py
"""
from __future__ import annotations

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "themes.css"

# 프리픽스 그룹
BG_PREFIXES = ["bg"]
TEXT_PREFIXES = ["text", "placeholder", "decoration"]
LINE_PREFIXES = ["border", "ring", "divide", "outline"]
VARIANTS = ["", "hover", "focus", "focus-within", "disabled", "group-hover"]

# ─────────────────────────────────────────────────────────────
# 테마 정의 — { 원본 hex : 대체 hex }. 매핑에 없는 색은 노션 원본 그대로.
# ─────────────────────────────────────────────────────────────
THEMES: dict[str, dict] = {
    # ⑥ 드라큘라 — 남보라 다크 + 네온 퍼플/핑크/그린 (화려한 다크)
    "dracula": {
        "dark": True,
        "body": {"background": "#282a36", "color": "#f8f8f2"},
        "bg_white": "#2c2e3b",
        "text_white": "#282a36",  # 주 버튼이 밝은 퍼플이라 흰 글자 반전 필요
        "bg": {
            "#f7f7f5": "#343746", "#fbfbfa": "#2e3040", "#f1f1ef": "#44475a",
            "#efefed": "#3f4254", "#ececea": "#4d5066", "#e0e0de": "#4d5066",
            "#e9e9e7": "#44475a", "#e8e7e4": "#4d5066", "#f7f6f3": "#343746",
            "#fafafa": "#2e3040", "#565452": "#a674f0",  # 어두운 hover 도 밝게 (반전 글자와 짝)
            "#37352f": "#bd93f9", "#2b2925": "#a674f0",  # 주 버튼 → 드라큘라 퍼플
            "#4a9eff": "#bd93f9",
            "#faf7ff": "#343048", "#c8b6ff": "#7862a8", "#6f5aa8": "#c9aef7",
            "#ede9fe": "#3d3654", "#f3efff": "#3d3654", "#f1ebff": "#3d3654",
            "#fdf2f2": "#48303a", "#fdf0f0": "#48303a",
            "#fff9eb": "#45422d", "#fff7e6": "#45422d", "#fef3c7": "#45422d",
            "#fffce8": "#45422d", "#fef9e7": "#45422d",
            "#f5f8ff": "#333a52", "#e7f0ff": "#333a52", "#f0fdf4": "#2f4636",
            # 대비 감사에서 발견된 누락 배경 (밝은 배경 + 밝은 글자 조합 방지)
            "#e5dbff": "#3d3654", "#eee9ff": "#3d3654", "#f7f4ff": "#343048",
            "#fbf9ff": "#343048", "#e7edf9": "#333a52", "#f0f7ff": "#333a52",
            "#fdf8ea": "#45422d", "#e7f5ef": "#2f4636",
            "#5d4a91": "#b183f7", "#5c4a92": "#b183f7",  # steer hover — 어두운 채 남으면 반전 글자 실종
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#e3e2e0": "#4d5066", "#eee0d6": "#4a4038", "#faebdd": "#4a4038", "#fbf3db": "#45422d",
            "#dbeddb": "#2f4636", "#dbeaf4": "#333a52", "#eae4f2": "#3d3654", "#f4dfeb": "#48303f",
            "#fbe4e4": "#48303a",
            # 변수 클래스 문자열(recovery 카드 등)에서 쓰여 감사가 놓쳤던 밝은 배경들
            "#fffcf5": "#45422d", "#f4f8ff": "#333a52", "#fdfcff": "#343048", "#faf0ff": "#343048",
            "#e8e8e5": "#44475a", "#dcdbd8": "#4d5066", "#c9c8c4": "#565a75",
        },
        "text": {
            "#37352f": "#f8f8f2", "#2b2925": "#f8f8f2",
            "#5f5e5b": "#d8d8d2", "#7d7c78": "#a3abcc", "#787774": "#a3abcc",
            "#9b9a97": "#8290bd", "#b3b2ae": "#6b7699",
            "#c8c7c4": "#525b7d", "#c9c8c4": "#525b7d", "#c7c6c2": "#525b7d",
            "#d3d1cb": "#525b7d", "#243d73": "#b9c9f0",
            "#6f5aa8": "#d6bdfc", "#5d4a91": "#d6bdfc", "#8a6ff0": "#bd93f9",
            "#9b91c1": "#8b7fb8", "#8a7bb8": "#c2aee8", "#8f83b4": "#9d92c4",
            "#375a9e": "#8be9fd", "#2f6fd0": "#8be9fd", "#216fbe": "#8be9fd",
            "#4a5568": "#c4cbe8",
            "#c92a2a": "#ff7b7b", "#a12a2a": "#ff8f8f",
            "#0f7a48": "#50fa7b",
            "#a67c1b": "#f1fa8c", "#8a6817": "#f1fa8c", "#92400e": "#f1fa8c",
            "#80621a": "#f1fa8c", "#795f28": "#f1fa8c", "#5f4811": "#e4ee7a",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#8a5a3b": "#e0b088", "#b34d15": "#ffb86c", "#217a3f": "#50fa7b",
            "#1f6fb2": "#8be9fd", "#7c56b7": "#d6bdfc", "#c94b8c": "#ff79c6",
        },
        "line": {
            "#e9e9e7": "#44475a", "#e3e2e0": "#4d5066", "#efefed": "#3f4254",
            "#f1f1ef": "#3f4254", "#eeeeec": "#3f4254", "#d3d1cb": "#565a75",
            "#8a8886": "#6272a4", "#37352f": "#bd93f9", "#4a9eff": "#bd93f9",
            "#c8b6ff": "#7862a8", "#d9ccff": "#544d70", "#e2d8fa": "#544d70",
            "#e8dcff": "#544d70", "#a8c8ff": "#5a6a9e",
            "#fbcaca": "#7a3d4a", "#f4dfab": "#6e6a3a", "#e7f5ef": "#3a5a44",
            "#f4e9c8": "#6e6a3a", "#e7e0cf": "#6e6a3a", "#c9dcff": "#5a6a9e",
            "#e6d4ff": "#544d70", "#efe9ff": "#3d3654", "#e3dcf7": "#544d70",
            "#d5e6ff": "#5a6a9e", "#f0e3c0": "#6e6a3a", "#c9d7f8": "#5a6a9e",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#d9c1ae": "#6e5a45", "#f2d3ac": "#6e5a45", "#f0dfa6": "#6e6a3a", "#b6dab6": "#3a5a44",
            "#b7d4e8": "#5a6a9e", "#d1c1e8": "#544d70", "#eec1da": "#6d3a4e", "#efbebe": "#7a3d4a",
        },
        "extra": """
[data-theme="dracula"] { color-scheme: dark; }
[data-theme="dracula"] [data-content-type="codeBlock"] { background: #f8f8f2 !important; border-radius: 8px; }
""",
    },

    # ⑦ 로제 파인 — 자주빛 뮤트 다크 + 로즈/골드/아이리스 파스텔
    "rosepine": {
        "dark": True,
        "body": {"background": "#191724", "color": "#e0def4"},
        "bg_white": "#1d1b29",
        "text_white": "#191724",  # 주 버튼이 밝은 로즈라 흰 글자 반전 필요
        "bg": {
            "#f7f7f5": "#1f1d2e", "#fbfbfa": "#1b1929", "#f1f1ef": "#26233a",
            "#efefed": "#242138", "#ececea": "#2a273f", "#e0e0de": "#2a273f",
            "#e9e9e7": "#26233a", "#e8e7e4": "#2a273f", "#f7f6f3": "#1f1d2e",
            "#fafafa": "#1b1929", "#565452": "#e2a9a6",  # 어두운 hover 도 밝게 (반전 글자와 짝)
            "#37352f": "#ebbcba", "#2b2925": "#e2a9a6",  # 주 버튼 → 로즈
            "#4a9eff": "#c4a7e7",
            "#faf7ff": "#252132", "#c8b6ff": "#6d5f8e", "#6f5aa8": "#c4a7e7",
            "#ede9fe": "#2d2842", "#f3efff": "#2d2842", "#f1ebff": "#2d2842",
            "#fdf2f2": "#3c2634", "#fdf0f0": "#3c2634",
            "#fff9eb": "#3a3226", "#fff7e6": "#3a3226", "#fef3c7": "#3a3226",
            "#fffce8": "#3a3226", "#fef9e7": "#3a3226",
            "#f5f8ff": "#233242", "#e7f0ff": "#233242", "#f0fdf4": "#233a34",
            # 대비 감사에서 발견된 누락 배경
            "#e5dbff": "#2d2842", "#eee9ff": "#2d2842", "#f7f4ff": "#252132",
            "#fbf9ff": "#252132", "#e7edf9": "#233242", "#f0f7ff": "#233242",
            "#fdf8ea": "#3a3226", "#e7f5ef": "#233a34",
            "#5d4a91": "#cfb1ea", "#5c4a92": "#cfb1ea",  # steer hover — 반전 글자와 짝
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#e3e2e0": "#2a273f", "#eee0d6": "#3a3226", "#faebdd": "#3a3226", "#fbf3db": "#3a3226",
            "#dbeddb": "#233a34", "#dbeaf4": "#233242", "#eae4f2": "#2d2842", "#f4dfeb": "#3c2634",
            "#fbe4e4": "#3c2634",
            # 변수 클래스 문자열(recovery 카드 등)에서 쓰여 감사가 놓쳤던 밝은 배경들
            "#fffcf5": "#3a3226", "#f4f8ff": "#233242", "#fdfcff": "#252132", "#faf0ff": "#252132",
            "#e8e8e5": "#26233a", "#dcdbd8": "#2a273f", "#c9c8c4": "#403d52",
        },
        "text": {
            "#37352f": "#e0def4", "#2b2925": "#e0def4",
            "#5f5e5b": "#c5c1e0", "#7d7c78": "#908caa", "#787774": "#908caa",
            "#9b9a97": "#6e6a86", "#b3b2ae": "#5d5a72",
            "#c8c7c4": "#524f68", "#c9c8c4": "#524f68", "#c7c6c2": "#524f68",
            "#d3d1cb": "#524f68", "#243d73": "#b8dde3",
            "#6f5aa8": "#c4a7e7", "#5d4a91": "#c4a7e7", "#8a6ff0": "#c4a7e7",
            "#9b91c1": "#817da0", "#8a7bb8": "#b5aad4", "#8f83b4": "#918cb0",
            "#375a9e": "#9ccfd8", "#2f6fd0": "#9ccfd8", "#216fbe": "#9ccfd8",
            "#4a5568": "#bfbcd8",
            "#c92a2a": "#eb6f92", "#a12a2a": "#eb6f92",
            "#0f7a48": "#8ec5ad",
            "#a67c1b": "#f6c177", "#8a6817": "#f6c177", "#92400e": "#f6c177",
            "#80621a": "#f6c177", "#795f28": "#f6c177", "#5f4811": "#e3ae63",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#8a5a3b": "#d7ae8c", "#b34d15": "#e8a86a", "#217a3f": "#8ec5ad",
            "#1f6fb2": "#9ccfd8", "#7c56b7": "#c4a7e7", "#c94b8c": "#eb6f92",
        },
        "line": {
            "#e9e9e7": "#26233a", "#e3e2e0": "#2a273f", "#efefed": "#242138",
            "#f1f1ef": "#242138", "#eeeeec": "#242138", "#d3d1cb": "#403d52",
            "#8a8886": "#6e6a86", "#37352f": "#ebbcba", "#4a9eff": "#c4a7e7",
            "#c8b6ff": "#6d5f8e", "#d9ccff": "#4a4463", "#e2d8fa": "#4a4463",
            "#e8dcff": "#4a4463", "#a8c8ff": "#3e5a72",
            "#fbcaca": "#6d3a4e", "#f4dfab": "#6a5a35", "#e7f5ef": "#31473f",
            "#f4e9c8": "#6a5a35", "#e7e0cf": "#6a5a35", "#c9dcff": "#3e5a72",
            "#e6d4ff": "#4a4463", "#efe9ff": "#2d2842", "#e3dcf7": "#4a4463",
            "#d5e6ff": "#3e5a72", "#f0e3c0": "#6a5a35", "#c9d7f8": "#3e5a72",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#d9c1ae": "#6a5a35", "#f2d3ac": "#6a5a35", "#f0dfa6": "#6a5a35", "#b6dab6": "#31473f",
            "#b7d4e8": "#3e5a72", "#d1c1e8": "#4a4463", "#eec1da": "#6d3a4e", "#efbebe": "#6d3a4e",
        },
        "extra": """
[data-theme="rosepine"] { color-scheme: dark; }
[data-theme="rosepine"] [data-content-type="codeBlock"] { background: #e0def4 !important; border-radius: 8px; }
""",
    },

    # 미드나이트 잉크 — 먹빛 네이비 + 아이스 블루/라일락 (절제된 야간 다크)
    "midnight": {
        "dark": True,
        "body": {"background": "#0b1020", "color": "#e6edf7"},
        "bg_white": "#10182a",
        "text_white": "#0b1020",  # 밝은 아이스 블루 버튼에는 먹빛 글자를 사용
        "bg": {
            "#f7f7f5": "#121a2d", "#fbfbfa": "#0f1728", "#f1f1ef": "#1a2540",
            "#efefed": "#18233d", "#ececea": "#22304d", "#e0e0de": "#283653",
            "#e9e9e7": "#1a2540", "#e8e7e4": "#22304d", "#f7f6f3": "#121a2d",
            "#fafafa": "#0f1728", "#565452": "#4f8fe5",
            "#37352f": "#60a5fa", "#2b2925": "#4f8fe5",
            "#4a9eff": "#60a5fa",
            # 사고 과정·AI 조작 — 라일락 계열
            "#faf7ff": "#171c36", "#c8b6ff": "#5e5487", "#6f5aa8": "#a78bfa",
            "#ede9fe": "#252448", "#f3efff": "#252448", "#f1ebff": "#252448",
            # 오류·경고·정보·성공 상태
            "#fdf2f2": "#3a1d2a", "#fdf0f0": "#3a1d2a",
            "#fff9eb": "#3a3220", "#fff7e6": "#3a3220", "#fef3c7": "#3a3220",
            "#fffce8": "#3a3220", "#fef9e7": "#3a3220",
            "#f5f8ff": "#172b4d", "#e7f0ff": "#172b4d", "#f0fdf4": "#17372e",
            # 대비 감사에서 발견된 확장 배경
            "#e5dbff": "#252448", "#eee9ff": "#252448", "#f7f4ff": "#171c36",
            "#fbf9ff": "#171c36", "#e7edf9": "#172b4d", "#f0f7ff": "#172b4d",
            "#fdf8ea": "#3a3220", "#e7f5ef": "#17372e",
            "#5d4a91": "#9a7bea", "#5c4a92": "#9a7bea",
            # 노션 배지 팔레트
            "#e3e2e0": "#283653", "#eee0d6": "#3a2d28", "#faebdd": "#3a2d28", "#fbf3db": "#3a3220",
            "#dbeddb": "#17372e", "#dbeaf4": "#172b4d", "#eae4f2": "#252448", "#f4dfeb": "#3a2036",
            "#fbe4e4": "#3a1d2a",
            # recovery 카드 등 변수형 클래스
            "#fffcf5": "#3a3220", "#f4f8ff": "#172b4d", "#fdfcff": "#171c36", "#faf0ff": "#171c36",
            "#e8e8e5": "#1a2540", "#dcdbd8": "#22304d", "#c9c8c4": "#31415f",
        },
        "text": {
            "#37352f": "#e6edf7", "#2b2925": "#e6edf7",
            "#5f5e5b": "#c8d2e1", "#7d7c78": "#9aa8bd", "#787774": "#9aa8bd",
            "#9b9a97": "#7f8da3", "#b3b2ae": "#71809a",
            "#c8c7c4": "#5e6a80", "#c9c8c4": "#5e6a80", "#c7c6c2": "#5e6a80",
            "#d3d1cb": "#5e6a80", "#243d73": "#a9c9f5",
            "#6f5aa8": "#c4b5fd", "#5d4a91": "#c4b5fd", "#8a6ff0": "#a78bfa",
            "#9b91c1": "#8e82ae", "#8a7bb8": "#b9a9da", "#8f83b4": "#968ab6",
            "#375a9e": "#79b8ff", "#2f6fd0": "#79b8ff", "#216fbe": "#79b8ff",
            "#4a5568": "#bac6d8",
            "#c92a2a": "#fb7185", "#a12a2a": "#fb7185",
            "#0f7a48": "#6ee7b7",
            "#a67c1b": "#fcd34d", "#8a6817": "#fcd34d", "#92400e": "#fcd34d",
            "#80621a": "#fcd34d", "#795f28": "#fcd34d", "#5f4811": "#eabf3b",
            "#8a5a3b": "#d6a17b", "#b34d15": "#fdba74", "#217a3f": "#6ee7b7",
            "#1f6fb2": "#79b8ff", "#7c56b7": "#c4b5fd", "#c94b8c": "#f0abfc",
        },
        "line": {
            "#e9e9e7": "#1a2540", "#e3e2e0": "#283653", "#efefed": "#18233d",
            "#f1f1ef": "#18233d", "#eeeeec": "#18233d", "#d3d1cb": "#31415f",
            "#8a8886": "#52627e", "#37352f": "#60a5fa", "#4a9eff": "#60a5fa",
            "#c8b6ff": "#5e5487", "#d9ccff": "#463d68", "#e2d8fa": "#463d68",
            "#e8dcff": "#463d68", "#a8c8ff": "#345984",
            "#fbcaca": "#693142", "#f4dfab": "#64572b", "#e7f5ef": "#285044",
            "#f4e9c8": "#64572b", "#e7e0cf": "#64572b", "#c9dcff": "#345984",
            "#e6d4ff": "#463d68", "#efe9ff": "#252448", "#e3dcf7": "#463d68",
            "#d5e6ff": "#345984", "#f0e3c0": "#64572b", "#c9d7f8": "#345984",
            "#d9c1ae": "#5e493b", "#f2d3ac": "#5e493b", "#f0dfa6": "#64572b", "#b6dab6": "#285044",
            "#b7d4e8": "#345984", "#d1c1e8": "#463d68", "#eec1da": "#64304f", "#efbebe": "#693142",
        },
        "extra": """
[data-theme="midnight"] { color-scheme: dark; }
[data-theme="midnight"] [data-content-type="codeBlock"] { background: #e6edf7 !important; border-radius: 8px; }
""",
    },

    # 아이리스 스튜디오 다크 — 블랙 바이올렛 + 아이리스/오키드 (창작 집중형 다크)
    "irisdark": {
        "dark": True,
        "body": {"background": "#12101c", "color": "#f2ecfa"},
        "bg_white": "#171321",
        "text_white": "#181121",  # 밝은 아이리스 버튼에는 블랙 바이올렛 글자를 사용
        "bg": {
            "#f7f7f5": "#1b1729", "#fbfbfa": "#171421", "#f1f1ef": "#262038",
            "#efefed": "#241e35", "#ececea": "#302841", "#e0e0de": "#3c3152",
            "#e9e9e7": "#262038", "#e8e7e4": "#302841", "#f7f6f3": "#1b1729",
            "#fafafa": "#171421", "#565452": "#9477e7",
            "#37352f": "#a78bfa", "#2b2925": "#9273e3",
            "#4a9eff": "#a78bfa",
            # 사고 과정·AI 조작 — 오키드 계열
            "#faf7ff": "#20182f", "#c8b6ff": "#5b477f", "#6f5aa8": "#e879f9",
            "#ede9fe": "#322653", "#f3efff": "#322653", "#f1ebff": "#322653",
            # 오류·경고·정보·성공 상태
            "#fdf2f2": "#3a1d2a", "#fdf0f0": "#3a1d2a",
            "#fff9eb": "#3a3020", "#fff7e6": "#3a3020", "#fef3c7": "#3a3020",
            "#fffce8": "#3a3020", "#fef9e7": "#3a3020",
            "#f5f8ff": "#242044", "#e7f0ff": "#242044", "#f0fdf4": "#19352d",
            # 대비 감사에서 발견된 확장 배경
            "#e5dbff": "#322653", "#eee9ff": "#322653", "#f7f4ff": "#20182f",
            "#fbf9ff": "#20182f", "#e7edf9": "#242044", "#f0f7ff": "#242044",
            "#fdf8ea": "#3a3020", "#e7f5ef": "#19352d",
            "#5d4a91": "#d36ae7", "#5c4a92": "#d36ae7",
            # 노션 배지 팔레트
            "#e3e2e0": "#3c3152", "#eee0d6": "#3a2b2c", "#faebdd": "#3a2b2c", "#fbf3db": "#3a3020",
            "#dbeddb": "#19352d", "#dbeaf4": "#242044", "#eae4f2": "#322653", "#f4dfeb": "#3b2039",
            "#fbe4e4": "#3a1d2a",
            # recovery 카드 등 변수형 클래스
            "#fffcf5": "#3a3020", "#f4f8ff": "#242044", "#fdfcff": "#20182f", "#faf0ff": "#20182f",
            "#e8e8e5": "#262038", "#dcdbd8": "#302841", "#c9c8c4": "#493b61",
        },
        "text": {
            "#37352f": "#f2ecfa", "#2b2925": "#f2ecfa",
            "#5f5e5b": "#d8cfe4", "#7d7c78": "#b8acc8", "#787774": "#b8acc8",
            "#9b9a97": "#9385a4", "#b3b2ae": "#80728f",
            "#c8c7c4": "#6d607d", "#c9c8c4": "#6d607d", "#c7c6c2": "#6d607d",
            "#d3d1cb": "#6d607d", "#243d73": "#c4b5fd",
            "#6f5aa8": "#e9d5ff", "#5d4a91": "#e9d5ff", "#8a6ff0": "#c4b5fd",
            "#9b91c1": "#9e8db3", "#8a7bb8": "#c9b8dc", "#8f83b4": "#a997bc",
            "#375a9e": "#c4b5fd", "#2f6fd0": "#c4b5fd", "#216fbe": "#c4b5fd",
            "#4a5568": "#cfc3dc",
            "#c92a2a": "#fb7185", "#a12a2a": "#fb7185",
            "#0f7a48": "#6ee7b7",
            "#a67c1b": "#fcd34d", "#8a6817": "#fcd34d", "#92400e": "#fcd34d",
            "#80621a": "#fcd34d", "#795f28": "#fcd34d", "#5f4811": "#e9be3b",
            "#8a5a3b": "#d9a082", "#b34d15": "#fdba74", "#217a3f": "#6ee7b7",
            "#1f6fb2": "#c4b5fd", "#7c56b7": "#e9d5ff", "#c94b8c": "#f0abfc",
        },
        "line": {
            "#e9e9e7": "#302841", "#e3e2e0": "#3c3152", "#efefed": "#241e35",
            "#f1f1ef": "#241e35", "#eeeeec": "#241e35", "#d3d1cb": "#493b61",
            "#8a8886": "#665684", "#37352f": "#a78bfa", "#4a9eff": "#a78bfa",
            "#c8b6ff": "#5b477f", "#d9ccff": "#4e3c6e", "#e2d8fa": "#4e3c6e",
            "#e8dcff": "#4e3c6e", "#a8c8ff": "#51447a",
            "#fbcaca": "#693142", "#f4dfab": "#64552b", "#e7f5ef": "#295045",
            "#f4e9c8": "#64552b", "#e7e0cf": "#64552b", "#c9dcff": "#51447a",
            "#e6d4ff": "#4e3c6e", "#efe9ff": "#322653", "#e3dcf7": "#4e3c6e",
            "#d5e6ff": "#51447a", "#f0e3c0": "#64552b", "#c9d7f8": "#51447a",
            "#d9c1ae": "#5e473d", "#f2d3ac": "#5e473d", "#f0dfa6": "#64552b", "#b6dab6": "#295045",
            "#b7d4e8": "#51447a", "#d1c1e8": "#4e3c6e", "#eec1da": "#683353", "#efbebe": "#693142",
        },
        "extra": """
[data-theme="irisdark"] { color-scheme: dark; }
[data-theme="irisdark"] [data-content-type="codeBlock"] { background: #f2ecfa !important; border-radius: 8px; }
""",
    },

    # 플럼 아틀리에 — 웜 화이트 + 딥 플럼/앤티크 골드 (편집실 라이트)
    # Twill Code — 차콜 그라파이트 + 차분한 틸 코드 팔레트
    "graphiteteal": {
        "dark": True,
        "body": {"background": "#151719", "color": "#ccdDe3"},
        "bg_white": "#1b1f21",
        "text_white": "#101214",
        "bg": {
            "#f7f7f5": "#1b1f21", "#fbfbfa": "#171a1c", "#f1f1ef": "#252a2d",
            "#efefed": "#222629", "#ececea": "#2a3033", "#e0e0de": "#343b3e",
            "#e9e9e7": "#252a2d", "#e8e7e4": "#2a3033", "#f7f6f3": "#1b1f21",
            "#fafafa": "#171a1c", "#565452": "#5da69f", "#37352f": "#80cbc4",
            "#2b2925": "#61aaa3", "#4a9eff": "#80cbc4", "#faf7ff": "#202427",
            "#c8b6ff": "#465653", "#6f5aa8": "#80cbc4", "#ede9fe": "#293532",
            "#f3efff": "#293532", "#f1ebff": "#293532", "#fdf2f2": "#3a292a",
            "#fdf0f0": "#3a292a", "#fff9eb": "#383226", "#fff7e6": "#383226",
            "#fef3c7": "#383226", "#fffce8": "#383226", "#fef9e7": "#383226",
            "#f5f8ff": "#222b30", "#e7f0ff": "#222b30", "#f0fdf4": "#20342d",
            "#e5dbff": "#293532", "#eee9ff": "#293532", "#f7f4ff": "#202427",
            "#fbf9ff": "#202427", "#e7edf9": "#222b30", "#f0f7ff": "#222b30",
            "#fdf8ea": "#383226", "#e7f5ef": "#20342d", "#5d4a91": "#9bd8d1",
            "#5c4a92": "#9bd8d1", "#e3e2e0": "#343b3e", "#eee0d6": "#383226",
            "#faebdd": "#383226", "#fbf3db": "#383226", "#dbeddb": "#20342d",
            "#dbeaf4": "#222b30", "#eae4f2": "#293532", "#f4dfeb": "#382a34",
            "#fbe4e4": "#3a292a", "#fffcf5": "#383226", "#f4f8ff": "#222b30",
            "#fdfcff": "#202427", "#faf0ff": "#202427", "#e8e8e5": "#252a2d",
            "#dcdbd8": "#343b3e", "#c9c8c4": "#41494c",
        },
        "text": {
            "#37352f": "#ccdDe3", "#2b2925": "#ccdDe3", "#5f5e5b": "#b7c3c8",
            "#7d7c78": "#9da7ac", "#787774": "#9da7ac", "#9b9a97": "#707a7f",
            "#b3b2ae": "#616b70", "#c8c7c4": "#505a5f", "#c9c8c4": "#505a5f",
            "#c7c6c2": "#505a5f", "#d3d1cb": "#505a5f", "#243d73": "#89ddff",
            "#6f5aa8": "#c792ea", "#5d4a91": "#c792ea", "#8a6ff0": "#c792ea",
            "#9b91c1": "#9c8aaa", "#8a7bb8": "#b49ac3", "#8f83b4": "#a494b0",
            "#375a9e": "#82aaff", "#2f6fd0": "#82aaff", "#216fbe": "#82aaff",
            "#4a5568": "#b4c0c5", "#c92a2a": "#f78c6c", "#a12a2a": "#f78c6c",
            "#0f7a48": "#c3e88d", "#a67c1b": "#ffc857", "#8a6817": "#ffc857",
            "#92400e": "#ffc857", "#80621a": "#ffc857", "#795f28": "#ffc857",
            "#5f4811": "#e9b84e", "#8a5a3b": "#d7a17d", "#b34d15": "#f78c6c",
            "#217a3f": "#c3e88d", "#1f6fb2": "#89ddff", "#7c56b7": "#c792ea",
            "#c94b8c": "#f48fb1",
        },
        "line": {
            "#e9e9e7": "#252a2d", "#e3e2e0": "#343b3e", "#efefed": "#222629",
            "#f1f1ef": "#222629", "#eeeeec": "#222629", "#d3d1cb": "#41494c",
            "#8a8886": "#707a7f", "#37352f": "#80cbc4", "#4a9eff": "#80cbc4",
            "#c8b6ff": "#465653", "#d9ccff": "#3a4747", "#e2d8fa": "#3a4747",
            "#e8dcff": "#3a4747", "#a8c8ff": "#3c5860", "#fbcaca": "#704047",
            "#f4dfab": "#625735", "#e7f5ef": "#315144", "#f4e9c8": "#625735",
            "#e7e0cf": "#625735", "#c9dcff": "#3c5860", "#e6d4ff": "#3a4747",
            "#efe9ff": "#293532", "#e3dcf7": "#3a4747", "#d5e6ff": "#3c5860",
            "#f0e3c0": "#625735", "#c9d7f8": "#3c5860", "#d9c1ae": "#62513f",
            "#f2d3ac": "#62513f", "#f0dfa6": "#625735", "#b6dab6": "#315144",
            "#b7d4e8": "#3c5860", "#d1c1e8": "#3a4747", "#eec1da": "#59384a",
            "#efbebe": "#704047",
        },
        "extra": """
[data-theme="graphiteteal"] { color-scheme: dark; }
[data-theme="graphiteteal"] [data-content-type="codeBlock"] { background: #151719 !important; border: 1px solid #30363a; border-radius: 8px; }
[data-theme="graphiteteal"] .twill-terminal { background: #151719 !important; color: #ccdDe3; }
[data-theme="graphiteteal"] .twill-terminal-toolbar { border-color: #30363a !important; }
[data-theme="graphiteteal"] .twill-terminal-title { color: #ccdDe3 !important; }
[data-theme="graphiteteal"] .twill-terminal-restart { color: #9da7ac !important; }
[data-theme="graphiteteal"] .twill-terminal-restart:hover { background: #252a2d !important; color: #80cbc4 !important; }
""",
    },

    # 플럼 아틀리에 — 웜 화이트 + 딥 플럼/앤티크 골드 (편집실 라이트)
    "plum": {
        "body": {"background": "#fcf8fb", "color": "#382a35"},
        "bg_white": "#fffdfd",
        "bg": {
            "#f7f7f5": "#f4eaf1", "#fbfbfa": "#faf4f8", "#f1f1ef": "#ecdce7",
            "#efefed": "#e8d5e1", "#ececea": "#e2cfda", "#e0e0de": "#d9bfcd",
            "#e8e7e4": "#e2cfda", "#f7f6f3": "#f4eaf1", "#fafafa": "#faf4f8",
            "#565452": "#955371",
            "#37352f": "#7a284e", "#2b2925": "#651f40",
            "#4a9eff": "#7a284e",
            "#faf7ff": "#f8f1f6", "#c8b6ff": "#d9bfd0", "#6f5aa8": "#8c3a62",
            "#ede9fe": "#f3e6ee", "#f3efff": "#f3e6ee", "#f1ebff": "#f3e6ee",
            "#f5f8ff": "#f4eef7", "#e7f0ff": "#eee5f1",
            "#fff9eb": "#fbf4e7", "#fff7e6": "#fbf4e7", "#fffce8": "#fbf4e7",
        },
        "text": {
            "#37352f": "#382a35", "#5f5e5b": "#5f4d59", "#7d7c78": "#786575",
            "#787774": "#786575", "#9b9a97": "#927d8a", "#b3b2ae": "#a995a1",
            "#c8c7c4": "#bdabb5", "#c9c8c4": "#bdabb5", "#c7c6c2": "#bdabb5",
            "#375a9e": "#7a284e", "#2f6fd0": "#7a284e", "#216fbe": "#7a284e",
            "#6f5aa8": "#7a284e", "#5d4a91": "#7a284e",
            "#c92a2a": "#b91c1c", "#a12a2a": "#b91c1c",
            "#0f7a48": "#166534",
            "#a67c1b": "#8a5a00", "#8a6817": "#8a5a00",
        },
        "line": {
            "#e9e9e7": "#e2cfda", "#e3e2e0": "#d9bfcd", "#efefed": "#e8d5e1",
            "#f1f1ef": "#ecdce7", "#eeeeec": "#e8d5e1", "#d3d1cb": "#cfb4c3",
            "#8a8886": "#a38f9e", "#4a9eff": "#7a284e", "#37352f": "#7a284e",
            "#c8b6ff": "#d9bfd0", "#d9ccff": "#dbc6d4", "#e2d8fa": "#e3d3dd",
            "#e8dcff": "#e3d3dd", "#a8c8ff": "#cfb4c3",
        },
        "extra": "",
    },

    # ⑧ 민트 라이트 — 순백 + 틸 그린 포인트의 산뜻한 생산성 라이트
    "mint": {
        "body": {"background": "#ffffff", "color": "#1f2937"},
        "bg": {
            "#f7f7f5": "#f0faf8", "#fbfbfa": "#f7fcfa", "#f1f1ef": "#e2f4ef",
            "#efefed": "#ddf0ea", "#ececea": "#d3ebe4", "#e0e0de": "#c8e4dc",
            "#e8e7e4": "#d3ebe4", "#f7f6f3": "#f0faf8", "#fafafa": "#f7fcfa",
            "#565452": "#3d6b63",
            "#37352f": "#0f766e", "#2b2925": "#0c5f59",  # 주 버튼 → 틸 (흰 글자 4.5:1 대비)
            "#4a9eff": "#0d9488", "#f5f8ff": "#e6f7f3", "#e7f0ff": "#d9f2ec",
        },
        "text": {
            "#37352f": "#1f2937", "#5f5e5b": "#3f4c5a", "#7d7c78": "#5d6b78",
            "#787774": "#5d6b78", "#9b9a97": "#8496a2", "#b3b2ae": "#9fb0ba",
            "#c8c7c4": "#b6c6cf", "#c9c8c4": "#b6c6cf", "#c7c6c2": "#b6c6cf",
            "#375a9e": "#0b7f75", "#2f6fd0": "#0b7f75",
        },
        "line": {
            "#e9e9e7": "#d6ebe6", "#e3e2e0": "#c8e4dc", "#efefed": "#ddf0ea",
            "#f1f1ef": "#e2f4ef", "#eeeeec": "#ddf0ea", "#d3d1cb": "#a9cfc5",
            "#8a8886": "#8496a2", "#4a9eff": "#0d9488", "#37352f": "#0d9488",
        },
        "extra": "",
    },

    # ⑨ 선셋 웜 — 복숭아빛 웜 화이트 + 선명한 오렌지 포인트
    "sunset": {
        "body": {"background": "#fffaf5", "color": "#44403c"},
        "bg": {
            "#f7f7f5": "#fdf1e7", "#fbfbfa": "#fef6ee", "#f1f1ef": "#fae7d6",
            "#efefed": "#f8e2cd", "#ececea": "#f3d9c0", "#e0e0de": "#eed0b3",
            "#e8e7e4": "#f3d9c0", "#f7f6f3": "#fdf1e7", "#fafafa": "#fef6ee",
            "#565452": "#8a6a4e",
            "#37352f": "#d3500a", "#2b2925": "#b8430a",  # 주 버튼 → 오렌지 (흰 글자 대비 확보)
            "#4a9eff": "#ea580c", "#f5f8ff": "#fdeee0", "#e7f0ff": "#fbe6d2",
        },
        "text": {
            "#37352f": "#44403c", "#5f5e5b": "#635b52", "#7d7c78": "#78716c",
            "#787774": "#78716c", "#9b9a97": "#968e86", "#b3b2ae": "#b3aba3",
            "#c8c7c4": "#cfc6bd", "#c9c8c4": "#cfc6bd", "#c7c6c2": "#cfc6bd",
            "#375a9e": "#c2410c", "#2f6fd0": "#c2410c",
            "#c92a2a": "#b91c1c", "#a12a2a": "#b91c1c",
        },
        "line": {
            "#e9e9e7": "#f3ddc9", "#e3e2e0": "#eed0b3", "#efefed": "#f8e2cd",
            "#f1f1ef": "#fae7d6", "#eeeeec": "#f8e2cd", "#d3d1cb": "#dfc3a4",
            "#8a8886": "#a8a29e", "#4a9eff": "#ea580c", "#37352f": "#ea580c",
        },
        "extra": "",
    },

    # ④ 노르드 다크 — 블루-그레이 다크 (유일한 다크 테마)
    "nord": {
        "dark": True,
        "body": {"background": "#2e3440", "color": "#eceff4"},
        "bg_white": "#2f3541",
        "bg": {
            "#f7f7f5": "#3b4252", "#fbfbfa": "#353c4a", "#f1f1ef": "#434c5e",
            "#efefed": "#414a5c", "#ececea": "#4c566a", "#e0e0de": "#4c566a",
            "#e9e9e7": "#434c5e", "#e8e7e4": "#4c566a", "#f7f6f3": "#3b4252",
            "#fafafa": "#353c4a", "#565452": "#4c566a",
            "#37352f": "#5e81ac", "#2b2925": "#527399",  # 주 버튼 → 새도우 블루 (흰 글자 대비 확보)
            "#4a9eff": "#88c0d0",
            # 보라(사고 과정)
            "#faf7ff": "#3a3f52", "#c8b6ff": "#7a6a95", "#6f5aa8": "#7d6296",  # steer 버튼 — 흰 글자 대비
            "#ede9fe": "#463f5c", "#f3efff": "#463f5c", "#f1ebff": "#463f5c",
            # 상태 배경들
            "#fdf2f2": "#4a3439", "#fdf0f0": "#4a3439",
            "#fff9eb": "#4a4433", "#fff7e6": "#4a4433", "#fef3c7": "#4a4433",
            "#fffce8": "#4a4433", "#fef9e7": "#4a4433",
            "#f5f8ff": "#3a4358", "#f0fdf4": "#37443a", "#e7f0ff": "#3a4358",
            # 대비 감사에서 발견된 누락 배경
            "#e5dbff": "#463f5c", "#eee9ff": "#463f5c", "#f7f4ff": "#3a3f52",
            "#fbf9ff": "#3a3f52", "#e7edf9": "#3a4358", "#f0f7ff": "#3a4358",
            "#fdf8ea": "#4a4433", "#e7f5ef": "#37443a",
            "#5d4a91": "#6d5484", "#5c4a92": "#6d5484",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#e3e2e0": "#4c566a", "#eee0d6": "#4a4238", "#faebdd": "#4a4238", "#fbf3db": "#4a4433",
            "#dbeddb": "#37443a", "#dbeaf4": "#3a4358", "#eae4f2": "#463f5c", "#f4dfeb": "#4a3444",
            "#fbe4e4": "#4a3439",
            # 변수 클래스 문자열(recovery 카드 등)에서 쓰여 감사가 놓쳤던 밝은 배경들
            "#fffcf5": "#4a4433", "#f4f8ff": "#3a4358", "#fdfcff": "#3a3f52", "#faf0ff": "#3a3f52",
            "#e8e8e5": "#434c5e", "#dcdbd8": "#4c566a", "#c9c8c4": "#586380",
        },
        "text": {
            "#37352f": "#eceff4", "#2b2925": "#eceff4",
            "#5f5e5b": "#d8dee9", "#7d7c78": "#aab2c4", "#787774": "#aab2c4",
            "#9b9a97": "#8b93a8", "#b3b2ae": "#7b8398",
            "#c8c7c4": "#6b7386", "#c9c8c4": "#6b7386", "#c7c6c2": "#6b7386",
            "#d3d1cb": "#6b7386", "#243d73": "#a8c9e8",
            "#6f5aa8": "#c8b6e8", "#5d4a91": "#c8b6e8", "#8a6ff0": "#b48ead",
            "#9b91c1": "#8f84ad", "#8a7bb8": "#b3a6cf", "#8f83b4": "#9a90b8",
            "#375a9e": "#88c0d0", "#2f6fd0": "#88c0d0", "#216fbe": "#88c0d0",
            "#4a5568": "#c3cad8",
            "#c92a2a": "#e5a3ab", "#a12a2a": "#e5a3ab",
            "#0f7a48": "#a3be8c",
            "#a67c1b": "#ebcb8b", "#8a6817": "#ebcb8b", "#92400e": "#ebcb8b",
            "#80621a": "#ebcb8b", "#795f28": "#ebcb8b", "#5f4811": "#d9b96e",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#8a5a3b": "#d1a884", "#b34d15": "#d08770", "#217a3f": "#a3be8c",
            "#1f6fb2": "#88c0d0", "#7c56b7": "#b48ead", "#c94b8c": "#d98ab6",
        },
        "line": {
            "#e9e9e7": "#434c5e", "#e3e2e0": "#4c566a", "#efefed": "#414a5c",
            "#f1f1ef": "#414a5c", "#eeeeec": "#414a5c", "#d3d1cb": "#586380",
            "#8a8886": "#7b8398", "#37352f": "#88c0d0", "#4a9eff": "#88c0d0",
            "#c8b6ff": "#7a6a95", "#d9ccff": "#5d5675", "#e2d8fa": "#5d5675",
            "#e8dcff": "#5d5675", "#a8c8ff": "#5e81ac",
            "#fbcaca": "#7a4a52", "#f4dfab": "#7a6c43", "#e7f5ef": "#48584a",
            "#f4e9c8": "#7a6c43", "#e7e0cf": "#7a6c43", "#c9dcff": "#5e81ac",
            "#e6d4ff": "#5d5675", "#efe9ff": "#463f5c", "#e3dcf7": "#5d5675",
            "#d5e6ff": "#5e81ac", "#f0e3c0": "#7a6c43", "#c9d7f8": "#5e81ac",
            # 노션 배지 팔레트 — '대기' 등 상태 칩이 다크에서 안 보이던 문제 수정
            "#d9c1ae": "#6e5a45", "#f2d3ac": "#6e5a45", "#f0dfa6": "#7a6c43", "#b6dab6": "#48584a",
            "#b7d4e8": "#5e81ac", "#d1c1e8": "#5d5675", "#eec1da": "#6d4a5e", "#efbebe": "#7a4a52",
        },
        "extra": """
/* Nord: 스크롤바·코드 블록 보정 */
[data-theme="nord"] { color-scheme: dark; }
[data-theme="nord"] .scrollbar-thin::-webkit-scrollbar-track { background: transparent; }
/* 코드 하이라이트(light-plus)가 밝은 배경 전제라 코드 블록만 밝게 유지 */
[data-theme="nord"] [data-content-type="codeBlock"] { background: #eceff4 !important; border-radius: 8px; }
""",
    },

    # ⑤ 페이퍼 세피아 — 크림 종이 + 세피아 잉크 + 딥그린 포인트
    "paper": {
        "body": {"background": "#faf6ec", "color": "#433422"},
        "bg_white": "#fffdf6",
        "bg": {
            "#f7f7f5": "#f3ecdd", "#fbfbfa": "#f7f1e3", "#f1f1ef": "#ece3d0",
            "#efefed": "#e9dfc9", "#ececea": "#e4d9c0", "#e0e0de": "#ddd1b6",
            "#e8e7e4": "#e4d9c0", "#f7f6f3": "#f3ecdd", "#fafafa": "#f7f1e3",
            "#565452": "#6b5b45",
            "#37352f": "#4a6b50", "#2b2925": "#3d5942",  # 주 버튼 → 딥그린
            "#4a9eff": "#4a6b50", "#f5f8ff": "#eee8d5", "#e7f0ff": "#e6e8d8",
            "#faf7ff": "#f1ead9", "#fffce8": "#f5edd6", "#fff9eb": "#f5edd6",
            "#fff7e6": "#f5edd6",
        },
        "text": {
            "#37352f": "#433422", "#5f5e5b": "#6b5b45", "#7d7c78": "#8a7a63",
            "#787774": "#8a7a63", "#9b9a97": "#a19073", "#b3b2ae": "#b0a081",
            "#c8c7c4": "#c4b596", "#c9c8c4": "#c4b596", "#c7c6c2": "#c4b596",
            "#375a9e": "#4a6b50", "#2f6fd0": "#4a6b50",
            "#c92a2a": "#a4442e", "#a12a2a": "#a4442e",
            "#6f5aa8": "#7a5c46", "#5d4a91": "#7a5c46",
        },
        "line": {
            "#e9e9e7": "#e2d8c3", "#e3e2e0": "#ddd1b6", "#efefed": "#e9dfc9",
            "#f1f1ef": "#ece3d0", "#eeeeec": "#e9dfc9", "#d3d1cb": "#c9bb9c",
            "#8a8886": "#a19073", "#4a9eff": "#4a6b50", "#37352f": "#4a6b50",
            "#c8b6ff": "#c9bb9c", "#a8c8ff": "#c9bb9c",
        },
        "extra": """
/* Paper: 헤딩만 세리프 — 본문은 가독성 위해 산세리프 유지 */
[data-theme="paper"] .bn-container h1,
[data-theme="paper"] .bn-container h2,
[data-theme="paper"] .bn-container h3,
[data-theme="paper"] input[placeholder="제목 없음"] {
  font-family: Georgia, 'Times New Roman', 'Noto Serif KR', serif;
}
""",
    },
}


def esc_hex(hex_: str) -> str:
    return hex_.replace("#", r"\#")


def rule(theme: str, prefix: str, hex_: str, value: str, variant: str) -> str:
    cls = f"{prefix}-\\[{esc_hex(hex_)}\\]"
    if variant == "":
        sel = f'[data-theme="{theme}"] .{cls}'
    elif variant == "group-hover":
        sel = f'[data-theme="{theme}"] .group:hover .group-hover\\:{cls}'
    else:
        # hover:bg-[#x] → .hover\:bg-\[\#x\]:hover
        esc_variant = variant.replace("-", "-")
        sel = f'[data-theme="{theme}"] .{esc_variant}\\:{cls}:{variant}'
    if prefix == "bg":
        body = f"background-color: {value};"
    elif prefix in ("text", "placeholder"):
        body = f"color: {value};" if prefix == "text" else f"color: {value};"
        if prefix == "placeholder":
            sel += "::placeholder"
    elif prefix == "decoration":
        body = f"text-decoration-color: {value};"
    elif prefix == "border":
        body = f"border-color: {value};"
    elif prefix == "divide":
        sel += " > :not([hidden]) ~ :not([hidden])"
        body = f"border-color: {value};"
    elif prefix == "ring":
        body = f"--tw-ring-color: {value};"
    elif prefix == "outline":
        body = f"outline-color: {value};"
    else:
        raise ValueError(prefix)
    return f"{sel} {{ {body} }}"


def emit_theme(name: str, spec: dict) -> str:
    lines: list[str] = [f"/* ═══ theme: {name} ═══ */"]
    body = spec.get("body") or {}
    if body:
        lines.append(
            f'[data-theme="{name}"], [data-theme="{name}"] body {{ '
            f'background-color: {body.get("background", "#fff")}; color: {body.get("color", "#111")}; }}'
        )
    if spec.get("bg_white"):
        for variant in VARIANTS:
            if variant == "":
                lines.append(f'[data-theme="{name}"] .bg-white {{ background-color: {spec["bg_white"]}; }}')
            elif variant == "group-hover":
                continue
            else:
                lines.append(
                    f'[data-theme="{name}"] .{variant}\\:bg-white:{variant} {{ background-color: {spec["bg_white"]}; }}'
                )
    if spec.get("text_white"):
        # 어두운 배경(주 버튼 등)이 밝게 반전되는 테마에서 흰 글자가 안 보이는 문제 방지.
        # hover:text-white 같은 변형도 함께 반전해야 함 (TaskRunButton 등).
        lines.append(f'[data-theme="{name}"] .text-white {{ color: {spec["text_white"]}; }}')
        for variant in ("hover", "focus"):
            lines.append(
                f'[data-theme="{name}"] .{variant}\\:text-white:{variant} {{ color: {spec["text_white"]}; }}'
            )
    groups = [(BG_PREFIXES, spec.get("bg", {})), (TEXT_PREFIXES, spec.get("text", {})), (LINE_PREFIXES, spec.get("line", {}))]
    for prefixes, mapping in groups:
        for hex_, value in mapping.items():
            for prefix in prefixes:
                for variant in VARIANTS:
                    lines.append(rule(name, prefix, hex_, value, variant))
    if spec.get("extra"):
        lines.append(spec["extra"].strip())
    return "\n".join(lines)


def main() -> None:
    parts = [
        "/* 자동 생성 파일 — 직접 수정하지 말 것. frontend/scripts/generate_themes.py 를 수정 후 재실행. */",
        "/* 기본(노션) 테마는 오버라이드가 없어 현재 모습 그대로 유지된다. */",
    ]
    for name, spec in THEMES.items():
        parts.append(emit_theme(name, spec))
    OUT.write_text("\n\n".join(parts) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
