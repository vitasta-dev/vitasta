from facebook_business.api import FacebookAdsApi
from facebook_business.adobjects.adaccount import AdAccount
FacebookAdsApi.init(app_id, secret, token, api_version="v24.0")
AdAccount("act_123").get_insights()
