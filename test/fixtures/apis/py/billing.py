import stripe
import requests
from twilio.rest import Client
from facebook_business.api import FacebookAdsApi

stripe.api_version = "2022-11-15"
FacebookAdsApi.init(access_token="t", api_version="v20.0")


def charge():
    stripe.Customer.create(email="a@b.c")
    Client("sid", "tok").messages.create(to="+1", from_="+1", body="hi")
    return requests.get("https://graph.facebook.com/v21.0/me/accounts")
