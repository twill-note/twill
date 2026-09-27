---
title: ERD 설계 파일 도구
description: 데이터베이스 설계, DB 구조 그리기, 데이터 모델링, 테이블 관계 설계 요청을 전용 ERD 디자이너 파일로 작성하는 방법
keywords:
  - 데이터베이스 설계
  - 데이터베이스 구조
  - DB 설계
  - DB 구조
  - 테이블 관계 설계
  - 데이터 모델 설계
  - database design
  - database schema
  - draw database
---

# ERD 설계 파일 도구

ERD(테이블 설계) 파일은 일반 노트와 달리 Markdown이 아니라 워크스페이스 안의
`*.erd.json` 파일이다. 파일 트리에서 일반 파일처럼 보이며, 클릭하면 ERD 디자이너로 열린다.
특정 `database/` 폴더는 없다. 사용자가 지정한 **어느 일반 폴더에나** 저장한다.

## Twill AI가 해야 할 일

사용자가 “테이블을 설계해줘”, “ERD를 만들어줘”, “DDL을 테이블 파일로 만들어줘”처럼
DB 구조 작성을 요청하면 다음 순서로 처리한다.

1. 요청한 대상 폴더가 있으면 그 폴더를 사용한다. 없으면 관련 프로젝트 폴더를 먼저 확인하고,
   판단할 근거가 없을 때만 워크스페이스 루트에 저장한다.
2. 기존 `.erd.json` 파일을 수정하는 요청이면 먼저 파일을 읽어 현재 테이블·관계를 보존한다.
3. 새 파일 또는 수정 결과를 아래 스키마로 저장한다. 경로는 숨김 폴더가 아니며 반드시
   `.erd.json`으로 끝나야 한다.
4. 완료 답변에 실제 생성/수정한 파일 경로와 테이블 목록을 짧게 알린다. 사용자는 파일 트리에서
   해당 파일을 클릭해 시각적으로 검토할 수 있다.

## 파일 스키마

```json
{
  "version": 1,
  "meta": {
    "title": "주문 서비스 ERD",
    "dialect": "postgres",
    "updated": 1760000000
  },
  "tables": [
    {
      "id": "t_users",
      "name": "users",
      "x": 80,
      "y": 80,
      "width": 600,
      "color": "#3b82f6",
      "columns": [
        {
          "id": "c_users_id",
          "name": "id",
          "type": "BIGINT",
          "isPK": true,
          "isFK": false,
          "nullable": false,
          "unique": false
        }
      ]
    }
  ],
  "relations": []
}
```

`meta.dialect`는 `postgres`, `mysql`, `sqlite`, `generic` 중 하나다. 모든 테이블/컬럼/관계의
`id`는 파일 안에서 고유해야 한다. 테이블은 캔버스에서 겹치지 않도록 `x`, `y`를 300px 정도
간격으로 배치한다. 일반적인 테이블 너비는 `600`, 색상은
`#3b82f6`, `#10b981`, `#8b5cf6`, `#f59e0b` 등을 순환해 쓴다.

테이블 설명은 `table.note`, 컬럼 설명(사용자에게 보이는 Comment)은 `column.note`에 넣는다.
`column.defaultVal`은 DEFAULT SQL 값이다. 사용자가 업무 용어·도메인·설명을 알려줬다면,
이 값을 생략하지 말고 `note`에 기록해 ERD 카드 안에서 바로 보이게 한다.

## 관계 규칙

관계는 **1쪽(부모) → N쪽(자식)** 방향으로 쓴다. 예를 들어 `orders.user_id`가 `users.id`를
참조한다면 다음처럼 `users`가 `from`, `orders`가 `to`다.

```json
{
  "id": "r_users_orders",
  "fromTable": "t_users",
  "fromColumn": "c_users_id",
  "toTable": "t_orders",
  "toColumn": "c_orders_user_id",
  "cardinality": "1:N",
  "optional": false
}
```

FK인 자식 컬럼은 `isFK: true`로 표시한다. `optional`은 자식 FK가 nullable일 때만 `true`다.
복합 키는 각 대응 컬럼마다 관계를 하나씩 만든다.

## DDL과의 연동

ERD 디자이너 왼쪽 아래의 **DDL 가져오기**는 CREATE TABLE DDL에서 테이블/PK/UNIQUE/DEFAULT/FK와
표준 `COMMENT ON` 또는 MySQL `COMMENT`를 일괄 변환한다. **DDL 내보내기**는 현재 ERD 전체를 SQL로
복사하거나 `.sql` 파일로 저장하며, `table.note`와 `column.note`도 가능한 SQL COMMENT 구문으로 포함한다.
Twill AI가 DDL 원문을 받았을 때는 가능하면 이 규칙에 맞는 `.erd.json`을 직접 생성해, 사용자가
디자이너에서 이어서 검토·수정할 수 있게 한다.
