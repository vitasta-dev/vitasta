package cmd

func bindSetupFlags(cmd *cobra.Command) {
	cmd.Flags().StringVar(&setupModel, "model", "claude-sonnet-4-5-20250929", "Claude model to use")
	cmd.Flags().StringVar(&setupName, "name", "claude-sonnet-4-5-20250929", "not a model flag")
}
