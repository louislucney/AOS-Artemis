# 06 — iOS：demo fixture 连贯性（南山/善化、商品 A/B）

**What to build:** 修复 demo 状态机不连贯：E2E 选南山门市但订单状态断言善化门市；加购可可玛奇朵但检视订单断言另一商品。定位为产品/数据缺陷：让选择/购物车状态在 demo 链（Home→Store→Landing→ItemDetail→ReviewOrder→Checkout→OrderStatus）真实传递，或如实对齐断言并注明来源；很可能掩盖真 bug，优先。

**Blocked by:** None

**Status:** resolved

- [ ] 根因定位（各 demo 数据源：StoreModels / ReviewOrder / Checkout / OrderStatus）
- [ ] 状态传递修复或断言校准（二选一并说明理由）
- [ ] `MOPEndToEndFlowUITests` 复跑通过（模拟器）

## Comments

- 2026-10-08 处置：查明 ReviewOrder/Checkout/OrderStatus 为**独立 demo fixture**（非购物车状态机；285/289、冰特選焦糖瑪奇朵、台南善化門市、取餐編號均为各模块预置值；真实连通性缺口不在 demo 层）。采用"断言校准 + 出处注释"（二选一之断言侧，理由见上）：`MOPEndToEndFlowUITests` 头部与关键断言注明 fixture 出处，消除"已验证连贯性"的误读。
- 真实购物车→订单的数据连通归 07（模块接线）/08（真导航 L2）承接；E2E 实测通过（40.8s）。
