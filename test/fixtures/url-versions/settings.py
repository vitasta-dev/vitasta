"""Calls https://graph.facebook.com/v10.0/ (a docstring is prose)."""
import requests


class Settings:
    meta_graph_base_url: str = "https://graph.facebook.com/v23.0"


def send(profile, body):
    return post(f"https://graph.facebook.com/v21.0/{profile['phone_number_id']}/messages", body)


def followed():
    return requests.get("https://graph.facebook.com/v22.0/me")
