from transformers import AutoModelForCausalLM
MODEL_NAME = "meta-llama/Llama-3.3-70B-Instruct"
model = AutoModelForCausalLM.from_pretrained(MODEL_NAME)
