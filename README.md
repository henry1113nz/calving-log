# calving-log

A web application to help small dairy farms manage cow health events during the calving season.

## Problem

During New Zealand's seasonal calving, health events pile up fast. Smaller farms often track treated cows with paint marks and staff memory, which breaks down at shift handovers — things get missed.

## What it does

Records each cow's health events and shows a shared daily list, so anyone on shift knows what needs doing.

## Tech stack

- Backend: Node.js + Express
- Database: SQLite
- Frontend: React
- AI layer: LLM API for natural-language entry and queries

## Status

In development — COMPX576 project, University of Waikato.

背景是,牛用了抗生素之后,牛奶有一段时间不能挤进大罐卖,不然整罐奶都要报废。现在很多没有自动化设备的小农场,是靠人工画标记加员工记忆来管这件事,换班尤其是周末换人挤奶的时候,很容易漏掉、记错。我想把这个流程数字化,记一笔用药,系统自动算出啥时候能解禁,每天生成一个提醒清单。
有意思的地方是,这个停药期计算没有想象中简单——有些药是从"用药那天"开始算,但有些干奶期用的药,是从"牛下次产犊那天"开始算,因为用药的时候牛根本没在产奶。这个差异我是靠自己兽医背景才发现的,普通程序员写这个功能大概率会算错。所以我现在数据库里专门设计了一个字段,区分不同药该按哪种方式算。
next week
show database 