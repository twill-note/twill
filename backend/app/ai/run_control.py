"""Recognize direct run-control messages, without matching quoted or negated text."""
import re


def requests_pause(text: str) -> bool:
    text = re.sub(r"[.!?。！]+$", "", text.strip().lower()).strip()
    # Full matches intentionally leave explanatory/quoted statements to the model.
    return bool(re.fullmatch(
        r"(?:(?:현재|지금|일단|잠깐|잠시|우선|이제|하던|진행\s*중인)\s*)*"
        r"(?:(?:작업|실행|요청|업무)(?:을|를)?\s*)?"
        r"(?:일시\s*)?(?:중단|멈춰|멈추|그만|취소|정지)"
        r"(?:해|하|해줘|해줘요|해주세요|해두세요|해둬|해줄래|해줄래요|해주십시오|줘|주세요|세요|자|고|고\s*기다려|하고\s*기다려|하자)?",
        text,
    )) or bool(re.fullmatch(
        r"(?:please\s+)?(?:stop|pause|cancel|hold on|wait)(?:\s+(?:the\s+)?(?:current\s+)?(?:task|work|run))?(?:\s+(?:for now|please))?", text,
    ))
