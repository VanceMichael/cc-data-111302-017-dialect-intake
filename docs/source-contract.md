# 来源协议

GET /files/:name返回原始表格字节，Content-Type不声明编码。ambiguous中逗号和分号均可得到合法两列，late前30行可按逗号解释但末行的引号在后半部分冲突；semicolon使用逗号小数与引号内分号；utf16含BOM及CRLF。fixtures/schema.json给出字段语义，不指定方言。/control可切换selected，/selected返回当前同名文件的字节，身份须按内容区分。

## 通用控制

`GET /inventory` 返回本来源当前目录，`GET /health` 检查存活，`GET /state` 查看来源状态。`POST /control` 接收JSON对象，仅在来源支持的字段范围内操作。每次创建服务重新读取 fixtures/source.json；控制用于复现来源演进，不是采集业务的实现接口。

服务使用随机本地端口，测试启动与关闭均由代码负责。没有真实个人资料、凭据或付费调用。
