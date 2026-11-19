"""按域拆分的 FastAPI 路由包。

每个模块只负责一个域的 HTTP 边界（参数解析、状态码、响应形状），业务逻辑仍在
services/ 下。main.py 负责把 router 装到 app 上，不承载具体端点。
"""
