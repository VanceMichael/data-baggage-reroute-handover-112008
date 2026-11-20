# 跨航司签转时的行李交运凭据采集

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可设置 `SOURCE_PORT`。来源使用进程内演练时钟，启动时处于 `book`。用 `PUT /_source_clock?step=dispatch` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `book`、`dispatch`、`receive`、`withdraw`、`correction`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

票务 `/tickets/transfers` 提供按旅客代号与航段的改动。分拣 `/sorting/batches` 提供批次页地址，`/sorting/S8?page=1` 一类网页路径的 `next` 用于分批查看；序号由分拣点独立递增。`/receiving/handoffs` 列出接收批、旧原条码及可能分配的新条码。受理结果可以为各箱件独立填报，用签收时间标记现场动作，`seen` 是各来源自己的采集时间。
`/shifts/handover` 提供已交接的班组与联系人编号，`/reports/manual` 是可能晚到的地服现场双边确认，含交运号、原条码、双方以及移交用途。
